# 12 — 每店用量計量與成本分攤

## 1. 原則

- **Cloudflare 帳單不會按門店拆**（帳單只有帳號層級的各服務用量），所以必須**應用層自己計量**。
- 每月再用**實際帳單金額**，依各店用量占比**分攤**成「每店實際成本」；同時顯示「依單價估算成本」，兩者並列。
- 計量本身**不能讓成本上升到有感**，更**不能為了計量讓 DO 多醒**（ADR-019）。

## 2. 計量來源（逐項成本評估）

| 用量 | 來源 | 做法 | 額外成本（50／500 店／月） |
|---|---|---|---|
| Worker API 請求數、狀態碼、耗時 | **Workers Analytics Engine** | 每個 API 請求結束時 `env.USAGE.writeDataPoint({ indexes:[storeId], blobs:[route, method, statusClass, role], doubles:[1, wallMs] })`（非同步、不影響回應） | 3.15M／31.5M data points。**目前 Analytics Engine 不計費**；依公告價計費後：50 店 $0、500 店約 $5.4 |
| Worker CPU 時間 | 無法在 Worker 內讀取自身 CPU 時間 | 帳號層級總量由 GraphQL 取得，**依請求數占比分攤** | 0 |
| DO：WS 連線數、收訊數、取號數、叫號數、喚醒次數、估算活躍秒數、估算 rows written | **DO 內累加** | 計數器放在記憶體；**併入每次本來就要寫的 `meta.state` 列**（seq 與計數器同一列，每個事件本來就要更新 seq）→ **不增加 rows written**；每日關店 alarm 把「每 UTC 小時」的計數桶隨 q-history 送出 | 0（不新增 alarm、不新增寫入列） |
| R2 每店儲存量 | D1 `ad_assets.bytes` | 上傳完成時記錄大小；用量＝`SUM(bytes) WHERE status='ready'`，不掃 bucket | 0 |
| Web Push 發送數／失敗數 | Queue consumer | consumer 每批結束時依店彙總，寫 AE data point（每批每店 1 點） | ≤ 推播數，已含在上列估算內 |
| D1 歷史量 | Cron | 每日 `SELECT store_id, COUNT(*) FROM tickets_history GROUP BY store_id` | rows read 約 13.5M／日（500 店）＝ 405M／月，遠低於 25B 內含 |

### DO 計數器細節

```jsonc
// meta 表 key='state' 的 value（每個事件更新 seq 時一起寫，零額外列）
{ "seq": 1042,
  "u": { "h": "2026-10-27T05",          // 目前 UTC 小時桶
         "wsConn": 12, "wsIn": 340, "rpc": 41, "tickets": 37, "calls": 35,
         "wakes": 9, "events": 120, "rowsW": 444 },
  "uh": [ /* 已結束、尚未送出的小時桶，關店 alarm 時送出後清空 */ ] }
```

- `wakes`：建構式（從 hibernation 喚醒時會重新執行）在記憶體 +1，下次寫入 `state` 時落地。
- `estActiveSec` 不另存，由 `events × 0.05 + wakes × 0.01` 在彙總時推算（係數部署後以正式環境實測校正）。
- 限制：DO 若「醒來但沒有任何事件就被驅逐」，那次喚醒不會被計到——而這正是 hibernation 失效的情境，
  所以**夜間異常偵測不能只靠 DO 自己計數**，要搭配 §5 的 GraphQL 數據。

## 3. 資料表（D1，追加 migration `0004_usage.sql`；原規劃編號 0002 已被 M2 使用）

```sql
CREATE TABLE usage_hourly (            -- 保留 35 天
  store_id     TEXT NOT NULL,
  hour_start   INTEGER NOT NULL,       -- UTC epoch ms，整點
  api_requests INTEGER NOT NULL DEFAULT 0,
  api_errors   INTEGER NOT NULL DEFAULT 0,
  api_wall_ms  INTEGER NOT NULL DEFAULT 0,
  ws_connects  INTEGER NOT NULL DEFAULT 0,
  ws_messages  INTEGER NOT NULL DEFAULT 0,
  do_rpc       INTEGER NOT NULL DEFAULT 0,
  do_wakes     INTEGER NOT NULL DEFAULT 0,
  do_events    INTEGER NOT NULL DEFAULT 0,
  do_rows_written INTEGER NOT NULL DEFAULT 0,
  tickets      INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  push_sent    INTEGER NOT NULL DEFAULT 0,
  push_failed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, hour_start)
);

CREATE TABLE usage_daily (             -- 永久（無個資，每店每日一列）
  store_id     TEXT NOT NULL,
  date         TEXT NOT NULL,          -- UTC 日期（與 Cloudflare 計費日一致）
  api_requests INTEGER NOT NULL DEFAULT 0,
  api_errors   INTEGER NOT NULL DEFAULT 0,
  ws_connects  INTEGER NOT NULL DEFAULT 0,
  ws_messages  INTEGER NOT NULL DEFAULT 0,
  do_requests_est INTEGER NOT NULL DEFAULT 0,   -- ws_messages/20 + ws_connects + do_rpc + alarms
  do_active_seconds_est REAL NOT NULL DEFAULT 0,
  do_rows_written_est INTEGER NOT NULL DEFAULT 0,
  do_wakes_offhours INTEGER NOT NULL DEFAULT 0, -- 非營業時間的喚醒次數
  tickets      INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  push_sent    INTEGER NOT NULL DEFAULT 0,
  push_failed  INTEGER NOT NULL DEFAULT 0,
  r2_bytes     INTEGER NOT NULL DEFAULT 0,      -- 當日結束時的廣告儲存量
  d1_history_rows INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,         -- 依單價估算（不扣內含額度）
  PRIMARY KEY (store_id, date)
);

CREATE TABLE usage_monthly (
  store_id      TEXT NOT NULL,
  month         TEXT NOT NULL,         -- 'YYYY-MM'
  -- 各項加總（同 usage_daily 欄位，略）
  api_requests  INTEGER NOT NULL, ws_messages INTEGER NOT NULL, do_requests_est INTEGER NOT NULL,
  do_active_seconds_est REAL NOT NULL, do_rows_written_est INTEGER NOT NULL,
  tickets INTEGER NOT NULL, push_sent INTEGER NOT NULL, r2_byte_days INTEGER NOT NULL,
  est_cost_usd       REAL NOT NULL,    -- 依單價估算
  allocated_cost_usd REAL,             -- 依實際帳單分攤（輸入帳單後才有）
  PRIMARY KEY (store_id, month)
);

CREATE TABLE billing_inputs (          -- 每月實際帳單（總後台輸入，或由 GraphQL 用量×單價預填）
  month        TEXT NOT NULL,
  line_item    TEXT NOT NULL,          -- workers_base / workers_requests / workers_cpu / do_requests / do_duration /
                                       -- do_storage / d1 / kv / r2 / queues / analytics_engine / other
  amount_usd   REAL NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('invoice','graphql_estimate')),
  entered_by   TEXT,
  entered_at   INTEGER NOT NULL,
  PRIMARY KEY (month, line_item)
);
```

## 4. 彙總流程

| 時間（UTC） | 動作 |
|---|---|
| 每日關店後（各店自己的關店 alarm） | DO 把小時桶隨 q-history 送出 → consumer `INSERT ... ON CONFLICT DO UPDATE` 進 `usage_hourly`（DO 欄位） |
| 每日 00:20 | Cron：AE SQL API 查前一 UTC 日 `GROUP BY index1, toStartOfHour(timestamp)` → 寫 `usage_hourly`（API／push 欄位）→ 彙總成 `usage_daily`、計算 `est_cost_usd`、`r2_bytes`、`d1_history_rows` |
| 每月 1 日 00:40 | Cron：彙總上月 `usage_monthly`；以 GraphQL 取得帳號層級用量 × 單價，寫入 `billing_inputs (source='graphql_estimate')` 作預填 |
| 平台管理員輸入實際帳單後 | 計算 `allocated_cost_usd` |

- AE SQL API 由 Cron 一天查一次，總後台的「今日」數字才即時查 AE（每次開頁 1～2 個查詢，遠低於 1M／月內含）。
- 「已彙總但遲到」的 DO 小時桶（例如某店晚關店）：consumer 寫入後順便重算該日 `usage_daily`，冪等。
- AE 資料保留 3 個月 → 必須在保留期內彙總進 D1（每日彙總已滿足）。

## 5. 分攤公式

| 帳單項目 | 分攤依據（各店占比） |
|---|---|
| Workers 月費 $5 | 當月**活躍門店數平均分攤**（每店固定一份） |
| Workers requests、Workers CPU、KV | `api_requests` |
| DO requests | `do_requests_est` |
| DO duration | `do_active_seconds_est` |
| DO SQLite（rows written、storage） | `do_rows_written_est` |
| D1 | `tickets` |
| R2 | `r2_byte_days`（廣告、Logo）；語音包在 Pages，不產生費用 |
| Queues | `push_sent + tickets/25` |
| Analytics Engine | `api_requests` |

`allocated_cost(店) = Σ_項目 帳單金額(項目) × 店用量(項目) / 全店用量(項目)`；smoke 測試門店與平台自身流量另列「平台」一列，不攤給門店。

「依單價估算成本」＝ 該店用量 × 公告單價，**不扣內含額度**（代表邊際成本上限）。兩者並列時，估算值通常高於分攤值（因為內含額度被所有店共享）。

### GraphQL 能拿到什麼（查證狀態）

| 項目 | 狀態 |
|---|---|
| DO 資料集：`durableObjectsInvocationsAdaptiveGroups`、`durableObjectsPeriodicGroups`、`durableObjectsStorageGroups`、`durableObjectsSubrequestsAdaptiveGroups` | **已查證**存在（[DO metrics](https://developers.cloudflare.com/durable-objects/observability/graphql-analytics/)） |
| DO 資料集是否有 `objectId` 維度（能否細到每家店的 DO） | **未查證**——官方頁只說用 GraphQL introspection 查。實作第一步：introspection 確認。若有，夜間異常改用它（最準）；若無，只能用帳號層級＋DO 自計 |
| DO `activeTime`／`duration` 等指標名稱 | **未查證**（同上，以 introspection 為準） |
| 帳單金額（美元）是否可由 API 取得 | **未查證**；本設計不依賴，採人工輸入帳單＋GraphQL 用量×單價預填 |

## 6. 總後台頁面（`apps/admin` → 用量與成本）

```
┌──────────────────────────┐
│ 用量與成本   [2026-10 ▾] │
│ 帳號實際 $5.62 · 估算 $9.8│
│ [輸入帳單]   [匯出 CSV]   │
├──────────────────────────┤
│ 排序：分攤成本 ▾          │
│ ┌──────────────────────┐ │
│ │ 中山店   $0.14 / 估$0.31│ │
│ │ 號 9,120 · API 64k     │ │
│ │ ▁▂▃▅▃▂▁ 30 日趨勢      │ │
│ │ ⚠ 夜間喚醒 143 次      │ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ 信義店   $0.10 / 估$0.22│ │
│ │ 廣告 470/500MB ⚠       │ │
│ └──────────────────────┘ │
└──────────────────────────┘
```

| 區塊 | 內容 |
|---|---|
| 總覽 | 本月帳號實際（已輸入）／估算、活躍店數、每店平均 |
| 每店卡片／表格 | 今日、本月、30 日趨勢：號碼數、API 請求、WS 訊息、DO 估算活躍秒數、推播、R2 用量；估算成本與分攤成本並列 |
| 排行 | 依分攤成本、號碼數、每號成本排序 |
| 異常警示 | 見下表 |
| 匯出 | CSV（每店每日或每月） |

### 異常警示規則

| 警示 | 條件 | 可能原因 |
|---|---|---|
| 夜間 DO 未休眠 | GraphQL 該店 DO 非營業時間活躍時間 > 60 秒／小時（若有 objectId 維度）；否則 `do_wakes_offhours > 10／小時` | 有 `setTimeout`、`ws.accept`、異常裝置頻繁重連 |
| 請求量暴增 | 今日 `api_requests` > 近 7 日平均 × 3 且 > 5,000 | 灌號、前端 bug 迴圈重試 |
| 每號請求過高 | `do_requests_est / tickets` > 20 | 心跳錯接、輪詢 |
| 廣告容量 | ≥ 90% 黃、≥ 100% 紅 | — |
| 叫號機無法出聲 | 任一面板 `devices.audio_status = 'blocked'` 超過 5 分鐘（ADR-027） | 一般瀏覽器未點擊、kiosk 設定遺失 |
| 推播失敗率 | `push_failed / push_sent` > 20% | VAPID 設定錯、訂閱過期 |

## 7. 作為收費依據

用量數據同時是向門店收費、方案分級的依據；方案設計建議見 DECISIONS ADR-020。

## 8. 實作對照（M4，2026-10-27）

與上文規劃的差異與細節（決策見 ADR-044、ADR-045）：

| 項目 | 實作 |
|---|---|
| AE 寫入 | `apps/api/src/usage/ae.ts`：每請求 `indexes=[storeId 或 _platform]`、`blobs=[路由樣板, method, 狀態類別, 角色]`、`doubles=[1, wallMs]`。本機不綁 AE（測試以 mock binding 驗證） |
| DO 計數 | `state.u` 欄位：`wsConn, wsIn, rpc, alarms, tickets, calls, events, wakes, rowsW`；`rowsW` 估算＝每交易 +1、每事件 +2。T18：開／關計量的實際 rows written（SQLite cursor 量測）、alarm、meta 列完全相同 |
| 夜間喚醒 | DO 建構式在**門店當地非營業時間**寫 1 個 AE 點（`blob4='do'`，不算 API 請求）；每日匯入 `usage_hourly.do_night_wakes`。沒設營業時間的門店以 02:00～06:00 為深夜 |
| 推播計數 | q-push consumer 每批依店 upsert `usage_hourly.push_sent／push_failed`（最終結果才計：成功＝sent；放棄／404／410＝sent＋failed） |
| 彙總時間 | 沿用每小時 Cron：UTC 01:05 前一日（AE 匯入→全店日彙總）、每月 1 日 02:05 月結；查詢時缺的過去日子即時補算 |
| 表格 | `0004_m4_usage_admin.sql`：上文四張表＋`usage_hourly.do_alarms／do_night_wakes`、`usage_daily.do_rpc／do_wakes／do_wakes_offhours_max`、`usage_monthly.active_days／api_errors…` |
| 估算單價 | `apps/api/src/usage/prices.ts`（02 §1，查證日 2026-10-27）；每請求 CPU 3 ms、KV 0.5 次、D1 每號 8 列等假設同 02 §2 |
| 分攤 | `allocate()`：依 §5；某項全部用量為 0 改依估算成本占比，再為 0 則活躍門店平均；「其他」依估算成本占比；`features.internal` 門店與 `_platform` 不分 Workers 月費 |
| 警示 | `apps/api/src/usage/alerts.ts`：依 §6；推播失敗率需 ≥ 10 則；夜間依「非營業時間單一小時最多喚醒」> 10；面板無法出聲依 D1 狀態 > 5 分鐘（狀態改變即時寫入，ADR-045） |
| 總後台 | 「用量」分頁（月份切換、實際／估算、排行：成本／號碼數／每號成本、30 日趨勢、CSV）、每店用量頁、帳單輸入（12 項）。今日 API 請求數在 AE 已設定時即時查 |
| 未做 | GraphQL 帳號用量預填帳單（需 M0 0.5 introspection）；與帳號層級數字誤差 < 20% 的比對需正式環境跑一週 |

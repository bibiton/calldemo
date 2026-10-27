# 01 — 架構

## 1. 全貌

```
                         ┌──────────────── Cloudflare ────────────────────────────────┐
 顧客手機 (call-q) ─────▶│ Pages: customer   (靜態，免費)                              │
 人員手機 (call-staff)   │ Pages: staff / store / admin / display                      │
 叫號面板 (call-display) │                                                             │
 門店後台 (call-store)   │        ┌──────────────── Worker: api (Hono) ──────────────┐ │
 總後台 (call-admin)     │ api  ─▶│ 1. 驗身分 (JWT / Access / device token / QR token)│ │
                         │        │ 2. 門店開通檢查（isolate 記憶體 → KV，60s）       │ │
                         │        │ 3. 路由：主檔 CRUD → D1；即時 → StoreQueueDO       │ │
                         │        └──┬──────────────┬──────────────┬─────────────────┘ │
                         │           │ RPC / WS     │ SQL          │ get/put            │
                         │   ┌───────▼────────┐  ┌──▼──┐  ┌──────┐ ┌────▼──┐           │
                         │   │ StoreQueueDO   │  │ D1  │  │  KV  │ │  R2   │           │
                         │   │ （每店一個）    │  └──▲──┘  └──────┘ └───────┘           │
                         │   │ SQLite: 號碼、 │     │ batch insert                      │
                         │   │ 事件、序號、PII │     │                                   │
                         │   │ Hibernatable WS│  ┌──┴──────────── Queues ───────────┐  │
                         │   └──────┬─────────┘  │ q-history：結束號碼批次 → D1      │  │
                         │          └──send────▶ │ q-push：Web Push（VAPID 加密）    │──┼─▶ FCM / APNs / Mozilla
                         │                       └───────────────────────────────────┘  │
                         │   Cron：每日彙總 daily_stats、保留期限清理、孤兒推播訂閱清理   │
                         └─────────────────────────────────────────────────────────────┘
```

## 2. 各服務分工

| 服務 | 放什麼 | 不放什麼 | 理由 |
|---|---|---|---|
| **Pages** ×5 | 5 個 SPA 的靜態檔；**叫號語音包**（約 7,019 檔、約 50 MB，全門店共用，隨 `display` 部署，ADR-026） | 任何 SSR / Functions | 靜態請求免費無上限 |
| **Worker `api`**（Hono） | 驗證、開通檢查、主檔 CRUD、WS upgrade 轉交 DO、QR token 驗證、Queue consumer、Cron | 即時狀態 | 無狀態，水平擴展 |
| **StoreQueueDO** | 單店即時號碼、取號序號、狀態機、事件 seq、WS 廣播、**進行中號碼的姓名／手機** | 歷史、跨店查詢 | 單店單執行緒＝天然序列化，無競態 |
| **D1** | 品牌、門店、帳號、裝置、服務類別、櫃台、廣告主檔、歷史、每日統計、推播訂閱、稽核 | 即時寫入 | rows written 計費，只收批次 |
| **KV** | `license:<storeId>`（開通狀態＋設定摘要） | 即時狀態、計數器 | 讀便宜寫貴，同 key 1 寫／秒 |
| **R2** | 門店上傳的 Logo、廣告圖片／影片、（未來）報表匯出 NDJSON | 個資、平台共用的語音包 | 出口免費；只放「各店不同、會上傳」的檔案 |
| **Queues** | 歷史批次、Web Push 發送 | — | DO 不打外部網路；自帶重試 |
| **Cron** | 每日彙總、清理 | 高頻工作 | 免費觸發 |
| **Access** | 保護 `call-admin.jjoy.ai` 整個 host（含同源 `/api/*`，ADR-047） | 門店／人員 | 平台管理員 ≤ 50 人免費 |

## 3. 關鍵流程

### 3.1 顧客取號（掃面板上的動態 QR）

```
面板（已配對）每 120 秒用門店 QR 金鑰自行計算 token，重繪 QR（DO 不參與、不被喚醒）
  ↓ 顧客掃描 https://call-q.jjoy.ai/s/<storeCode>?w=<window>&k=<token>
Worker 驗證：門店開通 → HMAC(window) 相符 → window ∈ {現在, 前一個}
  ↓ 發「取號 session」JWT（10 分鐘、單次使用 jti）
顧客頁：選服務類別 → 填姓名＋手機 → 勾選個資同意 → 送出
  ↓ POST /api/s/<storeCode>/tickets（帶 session）
Worker → DO.takeTicket()
  DO：同手機已有進行中號碼？
     ├ 是，且姓名相符 → 回傳原號碼（顧客頁直接帶到原號碼頁）
     ├ 是，姓名不符 → 409「此手機已有進行中號碼，請洽櫃台」
     └ 否 → 依門店時區判斷營業日，必要時歸零 → 產生 A013 → 廣播 ticket.created
  ↓ 回傳 ticketId ＋ ticket token（僅此顧客能查詢／取消／訂閱推播）
顧客頁開 WS 等叫號；切背景 → 斷 WS，改由 Web Push 接手
```

### 3.2 店員叫號

```
人員手機 WS（已連在 DO）送 {type:"cmd", cmd:"callNext", counterId, cmdId}
  ↓ DO：狀態機轉換（waiting→called）、seq+1、寫 events、廣播
  ├ 面板：大字顯示＋語音片段播放＋廣告讓位
  ├ 顧客頁（前景）：響鈴／震動
  └ 顧客（背景、有訂閱）：DO → q-push → consumer 加密送出
```

### 3.3 號碼結束

```
done / skipped / no_show → DO 把「去個資化」的歷史列加入緩衝
緩衝 ≥ 25 筆或每日關店 alarm → 一則 q-history 訊息 → consumer 批次 INSERT D1，並刪除該批的推播訂閱
關店 alarm：清除當日所有姓名／手機原文
```

### 3.4 停用／到期

```
平台管理員停用門店 → D1 更新 → KV 覆寫 license:<id> → 呼叫 DO.suspend()
DO.suspend()：廣播 store.suspended（面板顯示「服務暫停」）→ 關閉所有 WS（code 4003）
之後任何請求：Worker 讀到停用（最遲 60 秒）→ 403
到期：Worker 比對 expires_at，不需任何排程即生效；DO 在下一次被喚醒時同樣檢查
```

## 4. 網域（ADR-049：只有 production，`jjoy.ai` 共用帳號，一律 `call-` 前綴）

| 子網域 | 指向 | 保護 |
|---|---|---|
| `call-admin.jjoy.ai` | Pages `call-admin-production`；`/api/*` 由 Worker route 接手（ADR-047） | Cloudflare Access（One-time PIN） |
| `call-store.jjoy.ai` | Pages `call-store-production` | 帳密 + JWT |
| `call-staff.jjoy.ai` | Pages `call-staff-production` | 人員 PIN（裝置先綁店） |
| `call-display.jjoy.ai` | Pages `call-display-production` | 裝置配對 |
| `call-q.jjoy.ai` | Pages `call-q-production`（apps/customer） | 動態 QR token |
| `call-api.jjoy.ai` | Worker `call-api-production` | 依路由 |
| `call-media.jjoy.ai` | R2 `call-media-production`（自訂網域，經 CF 快取；不開 r2.dev） | 公開唯讀、檔名含 hash |

資源命名與部署見 [08-deploy-and-ops](08-deploy-and-ops.md) §2。

## 5. 為何是「每店一個 DO」

- 單店所有叫號操作必須序列化（同一號碼不能被兩個櫃台同時叫）。DO 單執行緒天然滿足，不需鎖。
- 一店流量極低（每日數百號），遠低於單 DO 1,000 rps 軟上限。
- 每店獨立 → 一家店的問題不影響其他店；DO 數量無上限。
- WebSocket hibernation 每個 DO 上限 32,768 條連線，一店的面板＋人員＋等候顧客遠低於此。

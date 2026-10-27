# 02 — 成本模型

## 1. 已查證單價（查證日期 2026-10-27）

| 服務 | 項目 | Workers Paid 內含 | 超出單價 | 來源 |
|---|---|---|---|---|
| Workers | 月費 | — | **$5／帳號／月** | [workers/platform/pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers | Requests | 10M／月 | $0.30／M | 同上 |
| Workers | CPU time | 30M CPU-ms／月 | $0.02／M CPU-ms | 同上 |
| Workers | 靜態資產請求 | 免費無上限 | — | 同上 |
| Durable Objects | Requests（含 HTTP、RPC、**WS 訊息**、alarm） | 1M／月 | $0.15／M | [durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Durable Objects | 收到的 WS 訊息 | 以 **20:1** 折算為 request | — | 同上 |
| Durable Objects | Duration（wall-clock，**一律以 128 MB 計**） | 400,000 GB-s／月 | $12.50／M GB-s | 同上 |
| Durable Objects | 可 hibernate 的閒置 DO | **不計 duration**（即使尚未真的被 hibernate） | — | 同上 |
| DO SQLite | Rows read | 25B／月 | $0.001／M | 同上（2026-01 起計費） |
| DO SQLite | Rows written | 50M／月 | $1.00／M | 同上 |
| DO SQLite | Storage | 5 GB-month | $0.20／GB-month | 同上 |
| D1 | Rows read | 25B／月 | $0.001／M | [d1/platform/pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 | Rows written | 50M／月 | $1.00／M | 同上 |
| D1 | Storage | 5 GB | $0.75／GB-month | 同上 |
| KV | Reads | 10M／月 | $0.50／M | [workers/platform/pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| KV | Writes / Deletes / Lists | 各 1M／月 | $5.00／M | 同上 |
| KV | Storage | 1 GB | $0.50／GB-month | 同上 |
| R2 Standard | Storage | 10 GB-month | $0.015／GB-month | [r2/pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 | Class A（寫） | 1M／月 | $4.50／M | 同上 |
| R2 | Class B（讀） | 10M／月 | $0.36／M | 同上 |
| R2 | 出口流量 | **免費** | — | 同上 |
| Queues | Operations（每 64 KB 的寫、讀、刪各算 1 次） | 1M／月 | $0.40／M | [queues/platform/pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Workers Analytics Engine | Data points written | 10M／月 | $0.25／M（**目前官方註明尚未開始計費**） | [analytics-engine/pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| Workers Analytics Engine | Read queries | 1M／月 | $1.00／M（同上） | 同上 |
| Workers AI | Neurons | 10,000／日免費 | $0.011／1,000 neurons；`@cf/myshell-ai/melotts` $0.0002／音訊分鐘 | [workers-ai/platform/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)（本案不採用即時 TTS，ADR-003） |
| Pages | 靜態請求 | 免費無上限 | — | [pages/functions/pricing](https://developers.cloudflare.com/pages/functions/pricing/) |
| Pages | 免費方案建置 | 500 次／月、同時 1 個 | — | [pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Zero Trust（Access） | Free 方案 | **50 users** | 超過需整個帳號改 Pay-as-you-go **$7／user／月**（所有席位都計費） | [cloudflare.com/plans/sase-zero-trust.md](https://www.cloudflare.com/plans/sase-zero-trust.md)（「全數席位計費」一說來自社群討論，**未在官方頁逐字查證**） |

### 已查證的限制

| 項目 | 值 | 來源 |
|---|---|---|
| D1 單庫上限 | **10 GB**（Paid）／500 MB（Free） | [d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 每帳號庫數／總量 | 50,000 庫／1 TB | 同上 |
| D1 每次 invocation 查詢數 | 1,000（Paid） | 同上 |
| D1 Time Travel | 30 天（Paid） | 同上 |
| DO SQLite 單物件上限 | 10 GB（Paid） | [durable-objects/platform/limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| DO 單物件軟上限 | 1,000 rps | 同上 |
| DO 收訊 WS 訊息大小 | 32 MiB | 同上 |
| Hibernatable WS 連線數 | 32,768／DO | [durable-objects/api/state](https://developers.cloudflare.com/durable-objects/api/state/) |
| WS tag | 每條最多 10 個、每個 ≤ 256 字元 | 同上 |
| `serializeAttachment` | ≤ 16,384 bytes | [durable-objects/best-practices/websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) |
| KV 最短 cacheTtl | 30 秒 | [kv/platform/limits](https://developers.cloudflare.com/kv/platform/limits/) |
| KV 同 key 寫入 | 1 次／秒 | 同上 |
| Analytics Engine | 資料保留 3 個月；每次呼叫 1 index（≤ 96 bytes）、20 blobs、20 doubles；每 invocation ≤ 250 data points | [analytics-engine/limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| Cron Triggers | 250／帳號（Paid），以 **UTC** 執行 | [workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)、[cron-triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Pages 專案數 | 100／帳號；單檔 25 MiB；Free 20,000 檔／站 | [pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/) |

### 未查證（估算時採保守值）

- `setWebSocketAutoResponse` 自動回應**是否計入 DO request 數**：官方只說「不喚醒、不計 duration」。本模型**保守地把它當成一般收訊，以 20:1 計入 request**。
- KV 讀取命中邊緣快取時是否仍計費：保守視為**每次 `get` 都計費**。
- Cron 觸發是否計入 Workers request：保守視為計入（量極小，不影響結果）。
- Workers Rate Limiting binding 的價格：未查證，**本設計不依賴它**。

## 2. 量級假設

| 參數 | 值 | 說明 |
|---|---|---|
| 每店每日號碼 | 300 | 「數百號」取中值 |
| 每月天數 | 30 | |
| 營業時數 | 12 h | |
| 每店裝置 | 面板 2、人員 3 | |
| 心跳 | 30 秒一次（文字 `ping`） | |
| 顧客平均等候 | 15 分鐘，其中約一半時間頁面在前景 | |
| 背景推播比例 | 1 則／號（只對背景且有訂閱者發） | 保守 |
| DO 每次事件處理 wall-clock | 50 ms | 含 SQLite 寫入與廣播；偏保守 |
| 每號 DO SQLite rows written | 12 | 號碼列 4 次狀態更新、事件列 ~5、索引 |
| 每號 Worker requests | 7 | 掃碼驗證、取號、WS upgrade ×2、訂閱推播、重開頁 ×2 |
| Worker 平均 CPU | 3 ms／請求 | 含 JWT 驗證、Web Push 加密 |
| KV 讀取 | 0.5 次／Worker 請求 | isolate 記憶體快取 60 秒擋掉約一半 |
| 每號 Queue operations | 3.2 | 推播 1 則×（寫＋讀＋刪）＋歷史 1/25 則×3 |
| 每號 D1 rows written | 8 | 歷史列＋索引、推播訂閱寫入／刪除、統計、稽核攤提 |
| D1 歷史保存 | 90 天 | 見 03-data-model §4 |
| 每店廣告實際用量 | 200 MB（上限 500 MB） | 見 05-apps |

## 3. 每店每日用量推導

**DO requests**

| 來源 | 次／日 |
|---|---|
| 取號 RPC、顧客 WS 連線（含重連）、alarm 等 | 300 × 6 = 1,800 |
| 面板＋人員心跳：5 台 × 1,440 次 ÷ 20 | 360 |
| 顧客心跳：300 人 × 15 分鐘前景 × 2 次／分 ÷ 20 | 450 |
| 人員指令（每號約 4 則 WS）÷ 20 | 60 |
| **合計** | **≈ 2,600／日 ≈ 78,000／月** |

**DO duration**：每日約 3,000 個事件 × 0.05 s × 0.125 GB = **18.75 GB-s／日 ≈ 562 GB-s／月**。
心跳走 auto-response **不計 duration**；其他時間 DO 處於可 hibernate 狀態，**不計 duration**。

## 4. 三檔月成本（USD）

| 項目 | 50 店 | 200 店 | 500 店 |
|---|---|---|---|
| 月號碼數 | 450k | 1.8M | 4.5M |
| Workers 月費 | 5.00 | 5.00 | 5.00 |
| Workers requests（3.15M／12.6M／31.5M） | 0 | 0.78 | 6.45 |
| Workers CPU（9.5M／38M／95M ms） | 0 | 0.16 | 1.29 |
| DO requests（3.9M／15.6M／39M） | 0.44 | 2.19 | 5.70 |
| DO duration（28k／112k／281k GB-s） | 0 | 0 | 0 |
| DO SQLite writes（5.4M／21.6M／54M） | 0 | 0 | 4.00 |
| KV reads（1.6M／6.3M／15.8M） | 0 | 0 | 2.90 |
| D1 writes（3.6M／14.4M／36M） | 0 | 0 | 0 |
| D1 storage（0.6／2.2／5.5 GB） | 0 | 0 | 0.38 |
| Queues（1.44M／5.76M／14.4M ops） | 0.18 | 1.90 | 5.36 |
| R2 廣告與素材（10／40／100 GB） | 0 | 0.45 | 1.35 |
| Pages、Cron、Access（≤ 50 位平台管理員） | 0 | 0 | 0 |
| 用量計量：Analytics Engine（3.15M／12.6M／31.5M points；**目前不計費**） | 0 | 0 | 0（計費後約 5.4） |
| **合計** | **≈ $5.6** | **≈ $10.5** | **≈ $32.4** |
| 每店每月 | $0.11 | $0.05 | $0.06 |

> 500 店時 DO duration 用到內含額度的 70%。若每事件實際 wall-clock 是 100 ms（假設的 2 倍），
> 會超出約 162k GB-s → 多約 **$2／月**。仍在可接受範圍，但這是第一個要用實測值修正的數字。

> 廣告素材下載：面板以 Service Worker 快取、素材檔名含 hash 不可變，並經 `media.` 自訂網域由 CF 快取，
> 每台面板每個素材版本只下載一次 → R2 Class B 讀取遠低於 10M／月內含，估為 0。
> 叫號語音包（約 7,019 檔、約 50 MB）隨 `apps/display` 部署在 Pages：靜態請求免費無上限、無流量費 → **$0**（ADR-026）；
> 若放 R2，每台面板首次載入約 7,000 次 Class B 讀取，雖有內含額度與邊緣快取，仍是不必要的計量項目。
> 用量計量（12-usage-metering）在 DO 端不新增任何寫入列與 alarm，成本 0；Analytics Engine 若開始計費，500 店約 +$5.4。

## 5. 會讓成本爆掉的寫法（禁止清單）

| 寫法 | 後果（50 店／500 店，每月多出） | 對策 |
|---|---|---|
| WS 用 `ws.accept()`（不可 hibernate），DO 有連線就整天醒著 | 每店每日 86,400 s × 0.125 GB = 10,800 GB-s → **+$197／+$2,020** | 一律 `ctx.acceptWebSocket()` |
| DO 內 `setInterval` 做心跳／倒數 | 同上，DO 永遠醒著 → **+$197／+$2,020** | 心跳 auto-response、排程用 alarm |
| DO 自己在 `webSocketMessage` 回 pong | 每次 ping 喚醒 DO，duration 與 request 都上升 | `setWebSocketAutoResponse` |
| 面板每 2 秒輪詢 API | 50 店：2 台 × 21,600 次 × 30 日 × 50 = 64.8M Worker req ＋ 同量 DO req → **+$26** | 面板只用 WS |
| 每個事件直接寫 D1 | rows written 5 倍以上；D1 單執行緒成為全平台瓶頸 | 即時寫 DO、結束才批次進 D1 |
| 每個請求寫 KV（例如計數） | $5／M 寫入，且同 key 1 次／秒限制直接撞牆 | KV 只存開通狀態 |
| 動態 QR 用 DO alarm 每 1 分鐘輪換 | 50 店 × 1,440 次 × 30 = 2.16M alarm → +$0.17，而且每次喚醒還要廣播 | QR token 由面板以 HMAC 自算（ADR-012） |
| DO 內 `await fetch()` 推播服務 | 等待外部回應的 wall-clock 全計 duration | 交給 Queues |
| 廣告影片用 Cloudflare Stream | 依觀看分鐘計費，面板整天循環播放＝費用與營業時數成正比 | R2 ＋ 裝置端快取（ADR-016） |
| 廣告素材每次播放都從 R2 下載 | Class B 讀取量 × 播放次數 | Service Worker 快取＋版本號 manifest |
| 一個號碼的每次推播各發一則 Queue 訊息、各自 ≥ 64 KB | ops 倍增 | 推播 payload < 4 KB，歷史 25 筆一包 |
| 為了計量每店用量在 DO 另寫一列計數或另設 alarm | 每事件 +1 row written（500 店 +$22／月）或 DO 多醒 | 計數併入本來就要寫的 `meta.state` 列（ADR-019） |
| 即時語音合成（每次叫號呼叫 TTS） | 每次叫號一次外部呼叫＋延遲＋斷網就沒聲音 | 預錄素材＋裝置快取（ADR-003） |

## 6. 監控指標（成本健康度）

- **DO Duration（GB-s）夜間（非營業時間）應趨近 0**。若夜間仍有固定斜率，代表有 DO 沒睡著。
- DO requests／號碼數 比值應落在 4～10；> 20 代表有輪詢或心跳錯接。
- Queue backlog 應趨近 0。
- D1 資料庫大小：> 7 GB 時啟動分庫或縮短保留期（單庫上限 10 GB）。

## 7. 未來選項（目前不做）

- **報表匯出**：Cron 每日把增量歷史以 NDJSON 寫入 R2，地端 Postgres 拉取（R2 出口免費）。
  觸發條件：門店需要 > 90 天的明細報表，或需要跨店 BI。

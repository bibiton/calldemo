# 04 — 即時協定（WebSocket）

## 1. 連線端點

```
wss://call-api.jjoy.ai/ws/store/<storeId>?role=display|staff|customer&lastSeq=<n>
  驗證：display → device token；staff → staff JWT；customer → ticket token
  Sec-WebSocket-Protocol 帶 token（瀏覽器 WebSocket 無法自訂 header），Worker 驗證後原樣回傳 subprotocol
  實作：客戶端送 ["qcs.v1", "auth.<token>"]，伺服器回 "qcs.v1"（不回傳 token）。
  Worker → DO 的轉交以內部 header 帶門店與身分（JSON 經 encodeURIComponent，因 header 只能 ASCII）
```

Worker 驗證身分與門店開通狀態後，把 upgrade 請求轉給 `StoreQueueDO`。DO 端：

```ts
// 僅示意規範，非實作
const pair = new WebSocketPair();
this.ctx.acceptWebSocket(pair[1], [`role:${role}`, `ticket:${ticketId}`]); // tags 供定向廣播
pair[1].serializeAttachment({ role, deviceId, staffId, ticketId, counterId }); // ≤ 16 KB
```

## 2. Hibernation 規範（硬規則，Code Review 必查）

| 規則 | 理由 |
|---|---|
| 只用 `ctx.acceptWebSocket(ws, tags)`，禁止 `ws.accept()` | 後者讓 DO 不可 hibernate，duration 全天計費 |
| 只用 `webSocketMessage` / `webSocketClose` / `webSocketError` handler，禁止 `ws.addEventListener` | hibernation 後只有 handler 會被呼叫 |
| DO 內禁止 `setTimeout` / `setInterval` | 會阻止 hibernation |
| DO 內禁止 `await fetch(外部)` | 等待期間計 duration；外部呼叫走 Queues |
| 定時工作只用 `ctx.storage.setAlarm()`；目前**每店每日只有一個關店 alarm** | alarm 也是 request，也會喚醒 |
| 連線狀態存 `serializeAttachment`，記憶體內的 Map 只當快取，喚醒後由 `ctx.getWebSockets()` 重建 | hibernation 會清空記憶體 |
| 心跳：建構式內 `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` | 自動回應不喚醒 DO、不計 duration |
| 客戶端心跳送**文字訊息** `"ping"`（不是 JSON） | 瀏覽器 API 不能送協定層 ping frame；auto-response 以字串完全比對 |
| 定向廣播用 `ctx.getWebSockets("role:display")` 等 tag 過濾 | 不必在記憶體維護訂閱表 |

### 心跳與斷線判定（客戶端）

- 每 30 秒送 `ping`，10 秒內沒收到 `pong` → 視為斷線，重連。
- 重連退避：1s, 2s, 4s, 8s, 最多 30s，加 ±20% 隨機抖動（避免整店網路恢復時同時重連）。
- DO 端不主動判斷心跳逾時（那需要計時器）。死連線由 runtime 在 TCP 層關閉後觸發 `webSocketClose`。
- 需要時可用 `ctx.getWebSocketAutoResponseTimestamp(ws)` 在**下一次 DO 本來就醒著時**順便清掉過久沒心跳的連線。

## 3. 訊息格式

所有伺服器→客戶端訊息：

```jsonc
{ "t": "evt", "seq": 1042, "at": 1793000000000, "type": "ticket.called", "data": { ... } }
```

| `type` | 對象 | `data` |
|---|---|---|
| `hello` | 全部（連線後第一則，不佔 seq） | `{ serverTime, seq, role, store: {name, logoUrl, features}, qr?: {keyB64, keyVersion, windowSec} }`（`qr` 只給 display） |
| `snapshot` | 全部 | 完整目前狀態（等候中各類別數量、各櫃台目前號碼、近 10 筆已叫號）；staff 版含姓名原文與遮罩手機 |
| `ticket.created` | staff（含姓名／遮罩手機）、display（只有號碼與各類等候數） | `{ id, number, serviceId, waitingCount }` |
| `ticket.called` | 全部；customer 只收自己的 | `{ id, number, counterId, counterNo, recallCount, nameMasked? }` |

> `ticket.called`（含 recall，`recallCount` 遞增）是面板播放的**唯一觸發**：display 收到即放入播放佇列（叮咚→預錄叫號句→可選趣味句），補推（lastSeq 補送）收到的舊 `ticket.called` **只更新畫面不播放**（`at` 早於現在 30 秒以上即視為補推），避免重連時一次唸出一串舊號碼。

| `ticket.serving` / `ticket.done` / `ticket.skipped` / `ticket.no_show` / `ticket.cancelled` / `ticket.requeued` / `ticket.transferred` | 同上 | `{ id, number, ... }` |
| `queue.position` | customer（自己的） | `{ ticketId, ahead, etaMin }`（每次隊列前進時只推給受影響者） |
| `ads.manifest` | display | `{ version }`（面板收到後再 GET manifest，見 05-apps） |
| `settings.changed` | 全部 | `{ version }` |
| `store.suspended` | 全部 | `{ reason: "suspended" | "expired" }`，之後 DO 以 4003 關閉連線 |
| `store.closed` / `store.opened` | display、customer | 營業時間外顯示「休息中」 |

客戶端→伺服器（staff）：

```jsonc
{ "t": "cmd", "cmdId": "01J...", "cmd": "callNext", "args": { "counterId": "c3", "serviceIds": ["A"] } }
```

| `cmd` | `args` |
|---|---|
| `callNext` | `counterId, serviceIds?` |
| `call` | `ticketId, counterId`（指定叫號） |
| `recall` | `ticketId` |
| `startServing` | `ticketId` |
| `finish` | `ticketId` |
| `skip` | `ticketId` |
| `requeue` | `ticketId, position: "tail" | "original"` |
| `noShow` | `ticketId` |
| `transfer` | `ticketId, toServiceId?, toCounterId?` |
| `createTicket` | `serviceId, name?, phone?`（店員代客取號，QR 不可用時的備援） |
| `revealPhone` | `ticketId`（按住顯示完整手機；寫稽核） |

面板（display）→ 伺服器：`{ "t": "status", "audio": "ok" | "blocked", "client": "android_app" | "fully" | "chrome_kiosk" | "browser", "appVersion": "1.0.0" }`，
只在狀態改變時送；DO 存入該連線的 attachment、廣播 `device.status` 給 staff，並經 q-history 更新 D1（ADR-027）。

回應：`{ "t": "ack", "cmdId": "...", "ok": true, "seq": 1043, "result": {...} }` 或 `{ "t":"ack", "ok": false, "error": "TICKET_NOT_WAITING" }`。

- `cmdId` 由客戶端產生（ULID）。DO 先查 `cmd_dedup`：已處理 → 直接回原結果。網路重送不會叫兩次號。
- `cmd_dedup` 寫入與狀態變更在**同一個交易**。

## 3.5 排隊順序規則（ADR-042）

DO 是單執行緒：同一家店的取號、叫號、重排一定是一件接一件處理，所以「同一毫秒」也有明確的先後。

| 規則 | 說明 |
|---|---|
| 排序鍵 | 等候中號碼一律依 **`(sort_key, ord)`** 由小到大：`callNext`、「前面還有幾位」（顧客頁／推播）、人員端與門店後台等候清單**全部用同一個鍵** |
| `sort_key` | 取號時＝取號時間（ms）；隊尾重排＝重排當下時間；原位重排＝原取號時間 |
| `ord` | DO 內單調遞增的**入隊序號**（計數放在每次交易本來就要寫的 `meta.state` 列，零額外寫入）。取號時配發；**隊尾重排時重新配發**（等同此刻才入隊）；原位重排、轉櫃台保留原值 |
| 同一毫秒取號 | `sort_key` 相同 → 先被 DO 處理的 `ord` 較小、排在前面；號碼也是同一順序配發，所以叫號順序＝號碼遞增 |
| 隊尾重排 vs 同毫秒新取號 | 先發生者在前：重排前已取號者排在重排號碼之前，重排後才取號者排在之後 |
| 原位重排 | 回到原取號位置（原 `sort_key`、原 `ord`），即使與他人同一毫秒取號 |
| 重叫（recall） | 號碼不在等候中，不影響任何人的位置；只更新 `called_at` 與叫號序號 `call_seq` → 面板「近期叫號」排最前 |
| 近期叫號／櫃台目前號碼 | 依 `(called_at, call_seq)` 由新到舊；同一毫秒兩櫃台叫號時，後處理者在前 |
| 跨服務類別 | 專屬某類別的櫃台只叫該類別；服務全部類別的櫃台依 `(sort_key, ord)` 跨類別取最前者；「前面幾位」只算同類別 |
| 禁止 | 以 `rowid`（`VACUUM` 可能重編沒有 INTEGER PRIMARY KEY 的表）、號碼字串、`createdAt` 或只用 `sort_key` 排序。前端用 `@qcs/shared` 的 `queueOrder` |

測試：`apps/api/test/queue-order.test.ts`（含原始碼靜態檢查）、`packages/shared/test/queue-order.test.ts`。

## 4. seq、補推、去重

- 每個會改變狀態的事件分配 `seq = meta.seq + 1`，與狀態變更、`events` 插入在同一交易內完成。
- 客戶端記住最後處理的 `seq`（localStorage），重連帶 `lastSeq`。
- DO 收到連線：
  - `lastSeq` 為空、或比 `events` 中最小 seq 還舊、或差距 > 200 → 送 `snapshot`
  - 否則送 `events WHERE seq > lastSeq` 中**此角色可見**的事件
- 客戶端：`seq <= lastSeq` 的事件直接丟棄（去重）；發現跳號（收到 seq 比預期大 > 1，且中間事件屬於自己可見範圍）→ 主動送 `{t:"resync"}` 取 snapshot。
  - 因為 customer 只收部分事件，customer 端以 `snapshot`／`ticket.*` 的狀態為準，不做跳號檢查。
- 營業日切換時 seq **不歸零**（seq 是 DO 生命週期內單調遞增）。
- **不佔 seq 的訊息**（不寫 events、不補推，沒有 `seq` 欄位）：`hello`、`queue.position`、`device.status`。客戶端去重只看有 `seq` 的事件。
- customer 連線一律收 `snapshot`（只有自己的號碼與前面人數，資料量極小），不做事件補推。

## 5. 營業時間外（面板夜間策略，ADR-005）

- 連線**保持**（hibernated），面板依 `hello.store.businessHours` 與 `serverTime` 偏移在本地切換「休息中」畫面。
- 夜間心跳仍是 auto-response：不喚醒 DO、不計 duration。
- 面板不輪詢。若連線中斷，依退避重連；營業時間外退避上限放寬到 5 分鐘。

## 6. 顧客頁前景／背景

```
visibilitychange → hidden：送 close(1000)、改由 Web Push 接手（若已訂閱）
visibilitychange → visible：重連帶 lastSeq，立即拿到最新狀態
```

這讓等候中的顧客大部分時間不佔 DO 連線、不送心跳。

## 7. 動態 QR token（ADR-012）

面板顯示的 QR 由**面板自行計算**，DO 與 Worker 都不需要定時動作：

```
window   = floor((serverNow) / 120_000)                   // 120 秒一個時間窗
storeKey = HMAC-SHA256(QR_ROOT_SECRET, storeId + ":" + qrKeyVersion)   // Worker 算，配對後經 hello 下發給面板
token    = base32( HMAC-SHA256(storeKey, storeId + ":" + window) )[0..10]   // 10 字元 ≈ 50 bits
URL      = https://call-q.jjoy.ai/s/<storeCode>?w=<window>&k=<token>
```

- `serverNow` = 本機時間 + `hello.serverTime` 推算的偏移（避免電視時鐘不準）。
- Worker 驗證：`window ∈ {current, current-1}`（有效 120～240 秒）且 token 相符 → 發 10 分鐘取號 session（JWT，含 `jti`）。
  填表慢的顧客不受影響，因為 session 在掃碼當下就發了。
- 面板在時間窗切換前 5 秒預先算好下一張 QR，切換時不閃爍。
- 金鑰輪替：門店後台按「重設 QR 金鑰」→ `qr_key_version + 1` → KV 更新 → DO 廣播 `settings.changed` → 面板重新取 `hello`。
- 取號 session 的 `jti` 由 DO 記在 `take_sessions`，同一 session 只能取一張號。

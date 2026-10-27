# 11 — 本機開發與測試

查證日期 2026-10-27。來源：
[Development & testing](https://developers.cloudflare.com/workers/development-testing/)、
[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)、
[Vitest known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)、
[Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)、
[Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)。

## 1. 本機能模擬什麼（`wrangler dev`，workerd／Miniflare）

| 資源 | 本機 | 狀態 |
|---|---|---|
| Worker（Hono） | ✅ | 已查證 |
| Durable Objects | ✅（官方：DO 目前**一律在本機執行**，不支援 remote binding） | 已查證 |
| DO WebSocket Hibernation、`setWebSocketAutoResponse`、Alarm | 本機 workerd 執行同一套 runtime，預期可用 | **未查證**（官方頁未逐項說明；M1 第一個任務實測） |
| D1 | ✅ `wrangler d1 migrations apply qcs-db-staging --local --env staging`＋ seed | 已查證支援本機模擬 |
| KV、R2、Queues | ✅ 本機模擬 | 已查證 |
| Cron（scheduled handler） | ✅ `curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"`，或 Local Explorer 介面 | 已查證（舊版的 `--test-scheduled`＋`/__scheduled?cron=` 在現行文件未出現，**未查證**是否仍可用） |
| Analytics Engine | 本機寫入是否可查 | **未查證**；本機以 no-op stub 包一層 |
| Cloudflare Access | ❌ | 本機以 `DEV_BYPASS_ACCESS=1`（只在 `ENV=local` 生效，production 啟動時若偵測到即拒絕啟動）帶入假的平台管理員 |

- 本機資料預設存在 `.wrangler/state`（重開仍在；要清空就刪掉該資料夾）。持久化細節以 wrangler 實際行為為準。

## 2. `pnpm dev` 一鍵起全部

```
pnpm dev
 ├─ apps/api       wrangler dev --env local --port 8787         （Worker + DO + D1/KV/R2/Queues 本機模擬）
 ├─ apps/admin     vite --port 5171  → proxy /api, /ws → :8787
 ├─ apps/store     vite --port 5172
 ├─ apps/staff     vite --port 5173
 ├─ apps/display   vite --port 5174
 └─ apps/customer  vite --port 5175
```

- 用 `pnpm -r --parallel dev`；每個 Vite 的 `server.proxy` 把 `/api` 與 `/ws`（`ws: true`）轉到 8787。
- `pnpm dev:seed`：套用本機 migration ＋ 匯入 seed（1 品牌、2 門店、各 2 服務類別、3 櫃台、店長與 3 位人員、1 台已配對面板、smoke 門店、10 筆廣告測試素材）。
- `wrangler.toml` 增加 `[env.local]`，bindings 指向本機資源；secrets 放 `apps/api/.dev.vars`（不進 git）。

## 3. 自動化測試

### 3.1 單元／整合：Workers Vitest integration

- 套件：官方文件現行名稱為 **`@cloudflare/vitest-plugin`**，Test APIs 頁同時列出 `@cloudflare/vitest-pool-workers`；實作時以當時 npm 現行版本為準。
- 測試跑在本機 Miniflare，可用 `cloudflare:test` 的 `runInDurableObject`、`runDurableObjectAlarm`、`evictDurableObject`、
  `applyD1Migrations`、`createScheduledController`、`createMessageBatch`、`getQueueResult`。
- **已查證的限制**：
  - 儲存隔離是**每個測試檔**，不是每個測試（測試檔結束時復原寫入）。
  - **「DO 搭配 WebSocket」不支援 per-file storage isolation** → WebSocket 相關測試放在獨立的 vitest project，關閉 isolated storage，
    每個測試用**不同的 storeId**（＝不同 DO 實例）自行隔離。
  - 不支援 V8 原生 coverage，需用 Istanbul。
  - Vitest fake timers 對 KV、R2、cache 模擬器無效 → 時間相關邏輯（營業日、QR 時間窗）以**注入 clock** 測試。

### 3.2 必測情境

| # | 情境 | 怎麼測 | 通過條件 |
|---|---|---|---|
| T1 | 並發取號不重號 | 同一 DO 並發 200 個 `takeTicket` | 號碼 1..200 連續、無重複、無缺號 |
| T2 | lastSeq 補推不漏不重 | 連線→斷線→產生 30 事件→帶 lastSeq 重連 | 收到的 seq 恰為缺的 30 個、無重複；lastSeq 太舊時改收 snapshot |
| T3 | 門店停用 | 停用 API → 檢查 | API 回 403 `STORE_SUSPENDED`；已連線 WS 收到 `store.suspended` 並以 4003 關閉 |
| T4 | 到期 | 注入 clock 超過 `expires_at` | 403 `STORE_EXPIRED`，無需任何排程 |
| T5 | 每日歸零 | 注入 clock 跨門店時區午夜後取號 | 序號從 001 起；跨 UTC 午夜但未跨台灣午夜時**不**歸零 |
| T6 | 關店 Alarm | `runDurableObjectAlarm` | 未結束號碼轉 `no_show`、姓名／手機原文被清空、q-history 收到批次、用量小時桶送出 |
| T7 | 動態 QR 過期拒絕 | 產生 window-2 的 token | 401 `QR_EXPIRED`；window 與 window-1 通過；錯誤 token 401 |
| T8 | 取號 session 單次 | 同 session 取兩次 | 第二次 409 |
| T9 | 同手機重複取號 | 同手機＋同姓名再取 | 回傳原號碼；同手機不同姓名 → 409 |
| T10 | 手機格式 | `0912-345-678`、`+886912345678`、`0812345678` | 前兩者正規化通過、第三者 422 |
| T11 | 人員指令冪等 | 同 `cmdId` 送 `callNext` 兩次 | 只叫一號、第二次 ack 回原結果 |
| T12 | Hibernation 規範 | 靜態檢查（lint rule / grep）：DO 檔案內無 `setTimeout`、`setInterval`、`.accept()`、`addEventListener("message"` | CI 失敗即擋 |
| T13 | 個資保存 | q-history consumer 寫入 D1 的列 | 無姓名／手機原文；`name_masked`、`phone_masked`、`phone_hmac` 正確 |
| T14 | 叫號播放佇列（display，Vitest + jsdom／Web Audio mock） | 連續 3 筆 `ticket.called` | 依序播放、不重疊；每筆「叮咚→句型×N」；補推的舊叫號不播放 |
| T15 | 叫號時廣告讓位 | 播放中收到叫號 | 影片 `muted`＋`pause()`，佇列清空後恢復且從原位置續播 |
| T16 | 未解鎖音訊提示 | `AudioContext.state = "suspended"` | 顯示「請點一下畫面啟用聲音」；收到叫號時提示變紅 |
| T16b | 音訊被擋回報 | `play()` reject `NotAllowedError` | 送出 `{t:"status",audio:"blocked"}` 一次（狀態不變不重送）；解鎖後送 `ok` |
| T16c | 模式判斷 | UA 加 `QueueDisplayApp/1.0` 且音訊被擋 | 不顯示任何提示、仍回報 `blocked`；web 模式下 `keydown`（Enter）可解鎖，Esc 不解鎖 |
| T17 | 趣味語音頻率 | `funEvery=5` 叫 10 次 | 插入 2 次；重叫不插 |
| T18 | 用量計量不增加寫入 | 比較開／關計量時 DO rows written | 相同 |

### 3.3 E2E：Playwright（手機直版 viewport）

- 專案設定：`devices["Pixel 7"]`（直立）與 `devices["iPhone 14"]`（直立）；面板用 1080×1920 viewport。
- 主流程：**掃碼取號 → 人員叫號 → 面板顯示**
  1. 面板頁讀出目前 QR 網址（測試模式下 QR 內容同時寫在 `data-qr-url`）
  2. 顧客 context 開該網址 → 選服務 → 填姓名手機 → 勾同意 → 取號，記下號碼
  3. 人員 context 登入 → 叫下一號
  4. 斷言：面板大字號碼＝該號、播放佇列收到 1 筆；顧客頁出現全螢幕叫號提示
- 其他 E2E：停用門店後面板顯示「服務暫停」、QR 區顯示「暫停取號」；廣告上傳超過 50 MB 被前端擋下。

## 4. 本機做不到 → staging 驗證

| 項目 | 方法 |
|---|---|
| 手機實機掃 QR、Service Worker、Web Push（都需要 HTTPS） | `cloudflared tunnel --url http://localhost:5175`（quick tunnel 給一次性 HTTPS 網址）做快速實機試；正式驗證在 staging |
| iOS 加入主畫面推播（16.4+） | staging，實機 iPhone |
| 叫號機實機：音訊解鎖、kiosk 免點擊、2～3 公尺掃 QR | staging，實際電視／電視盒 |
| Cloudflare Access | staging 的 `admin.staging.<domain>` |
| **DO Duration 夜間趨近 0** | staging 放一晚：面板＋人員端保持連線過夜，隔天看 DO Duration 圖，非營業時段應為平線 |
| 壓測 | k6 對 staging：尖峰取號（單店 5 分鐘內 300 號）＋ 50 台面板同時連線＋同時叫號廣播；看 p95 叫號延遲 < 1 秒、無錯誤 |

## 5. 開發流程

```
本機 pnpm dev 開發
  → pnpm test（Vitest 全過，含 T12 hibernation 靜態檢查）
  → push 到非 main 分支 → GitHub Actions 自動部署 staging → 實機驗證（§4）
  → 合併 main → 自動部署 production（可設人工核准）
```

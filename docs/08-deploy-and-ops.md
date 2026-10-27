# 08 — 部署與維運

> 本章的腳本在 `scripts/`，**2026-10-27 已在共用帳號首次實際部署並實測**（bootstrap 兩次、deploy、smoke、smoke 失敗自動回滾、回滾演練）；狀態見 [09-roadmap](09-roadmap.md)「M6／M7 實作狀態」。
> 前端是 5 個 **assets-only Worker**（不是 Pages，ADR-050）；Analytics Engine 暫未綁定（帳號未啟用，§3）。
> 業主版的逐步教學見 [10-deploy-guide-for-owner](10-deploy-guide-for-owner.md)。本機開發與測試見 [11-local-testing](11-local-testing.md)。
> **只有 production 一個環境**（ADR-049：DEMO 用途、成本最低）。流程：本機 `pnpm dev`＋`pnpm test`＋`pnpm e2e` 全過 →
> 一鍵部署到 production → 部署後在正式網址驗證（smoke＋手機／電視實機）。

## 1. Monorepo

```
queue-call-system/
├─ pnpm-workspace.yaml          packages: ["apps/*", "packages/*"]
├─ package.json                 scripts: dev / test / e2e / build
├─ apps/
│  ├─ api/                      Worker（Hono）+ StoreQueueDO + queue consumer + scheduled
│  │  ├─ wrangler.toml          [env.local]（本機／測試）＋ [env.production]（唯一部署環境）
│  │  ├─ migrations/            D1 migration（0001_init.sql ...）
│  │  └─ src/
│  ├─ admin/ store/ staff/ display/ customer/    Vite + React + Tailwind
│  │  └─ wrangler.toml          各自一個 assets-only Worker（[env.production]：call-<sub>-production＋Custom Domain，ADR-050）
│  ├─ display-android/          叫號機 Android WebView 包裝 App（Kotlin，ADR-027）
├─ packages/shared/             型別、WS 協定、mask、phone、qr-token
├─ assets/audio/                預錄語音素材 + manifest.json（建置時複製進 apps/display/public/audio，隨 call-display 前端 Worker 部署）
├─ assets/demo/                 Demo 品牌素材（廣告、影片、Logo）＋ CREDITS.md ＋ manifest.json（13-demo-seed）
├─ e2e/production/              正式網址 E2E（pnpm e2e:prod，設定檔 e2e/playwright.production.config.ts）
└─ scripts/                     bootstrap.sh deploy.sh rollback.sh smoke.sh smoke-ws.mjs lib.sh lib.test.sh
```

## 2. 環境與命名（ADR-049）

`jjoy.ai` 在**共用的 Cloudflare 帳號**上（同帳號還有 noah／ecshop／pos／reserve 等產品）。
本專案所有資源一律 **`call-` 前綴＋環境後綴**，腳本的安全閘（`scripts/lib.sh`）拒絕操作任何不是 `call-` 開頭的資源或不是 `call-*.jjoy.ai` 的網域。

| 項目 | local（本機／測試，不部署） | production（唯一部署環境） |
|---|---|---|
| Worker | `qcs-api-local` | `call-api-production` |
| D1 | `qcs-db-local` | `call-db-production` |
| KV | `qcs-license-local` | `call-license-production` |
| R2 | `qcs-media-local` | `call-media-production` |
| Queues | `qcs-history-local`、`qcs-push-local` | `call-history-production`、`call-push-production`（DLQ：`call-history-dlq-production`、`call-push-dlq-production`） |
| Analytics Engine | 不綁 | `call_usage_production`（AE dataset 名只能用底線；**帳號未啟用，binding 暫時註解**，§3） |
| 前端（assets-only Worker，ADR-050） | `pnpm dev`（Vite 517x） | `call-admin-production`、`call-store-production`、`call-staff-production`、`call-display-production`、`call-q-production` |
| Access 應用 | `DEV_BYPASS_ACCESS=1` | 應用 `call-admin`＋policy `call-admin-allow` |

| 子網域（`.jjoy.ai`） | 指向 | 保護 |
|---|---|---|
| `call-admin` | 前端 Worker `call-admin-production`（Custom Domain）；`/api/*` 由 API Worker route 接手（§7） | Cloudflare Access（整個 host） |
| `call-store` | 前端 Worker `call-store-production` | 帳密＋JWT |
| `call-staff` | 前端 Worker `call-staff-production` | 裝置綁店＋PIN |
| `call-display` | 前端 Worker `call-display-production` | 裝置配對 |
| `call-q` | 前端 Worker `call-q-production`（apps/customer） | 動態 QR token |
| `call-api` | Worker `call-api-production`（custom domain） | 依路由 |
| `call-media` | R2 `call-media-production`（自訂網域；**不開 r2.dev**） | 公開唯讀、檔名含 SHA-256 |

- `[env.local]` 的 `qcs-*-local` 名稱**不改**（Vitest、E2E、`seed-local.mjs` 依賴；不會建立任何雲端資源）。
- 前端 Worker 只放靜態資源（`[assets] directory = "./dist"`、`not_found_handling = "single-page-application"`、`workers_dev`／`preview_urls` 關閉），
  靜態資源請求免費且不限量（ADR-050 查證）。不用 Pages 的原因：共用帳號 Pages 專案數已達上限，且 wrangler 4.153 的 `pages project create` 實測失敗。
- 沒有 staging：不另付第二套資源、不維護兩套網域與 Access。代價是「部署後才能做實機驗證」，所以部署前的本機關卡加上 `pnpm e2e`，部署後 smoke 失敗自動回滾 Worker（§4.2）。

## 3. `apps/api/wrangler.toml`（production 段，實際檔案為準）

```toml
[env.production]
name = "call-api-production"
routes = [
  { pattern = "call-api.jjoy.ai", custom_domain = true },
  { pattern = "call-admin.jjoy.ai/api/*", zone_name = "jjoy.ai" },   # ADR-047，見 §7
]
vars = { ENV = "production",
         APP_ORIGINS = "https://call-admin.jjoy.ai,https://call-store.jjoy.ai,https://call-staff.jjoy.ai,https://call-display.jjoy.ai,https://call-q.jjoy.ai",
         MEDIA_BASE = "https://call-media.jjoy.ai", CUSTOMER_BASE_URL = "https://call-q.jjoy.ai", AE_DATASET = "call_usage_production" }
# （實際檔案 vars 寫成一行 inline table）

[[env.production.d1_databases]]          # database_name = "call-db-production"，database_id 由 bootstrap 寫入（原為 __D1_ID_PRODUCTION__ 佔位）
[[env.production.kv_namespaces]]         # id 由 bootstrap 寫入（原為 __KV_ID_PRODUCTION__ 佔位）
[[env.production.r2_buckets]]            # bucket_name = "call-media-production"
[[env.production.queues.producers]]      # call-history-production、call-push-production
[[env.production.queues.consumers]]      # 同上，dead_letter_queue = call-*-dlq-production
# [[env.production.analytics_engine_datasets]]  # binding USAGE → dataset call_usage_production（目前註解，見下）
[env.production.triggers]                # crons = ["5 * * * *", "30 19 * * *"]
```

前端 5 個 `apps/<app>/wrangler.toml`（以 display 為例）：

```toml
name = "call-display"
compatibility_date = "2026-10-01"
[assets]
directory = "./dist"
not_found_handling = "single-page-application"
[env.production]
name = "call-display-production"
workers_dev = false
preview_urls = false
routes = [{ pattern = "call-display.jjoy.ai", custom_domain = true }]
```

- **Analytics Engine 暫不綁定**（ADR-050）：2026-10-27 首次部署時 `wrangler deploy` 回錯誤 10089「You need to enable Analytics Engine」——共用帳號尚未啟用 AE。
  啟用是帳號層級設定（不屬於 `call-` 資源），腳本不代為啟用。業主在 dashboard → Workers & Pages → Analytics Engine 啟用後，
  把 `apps/api/wrangler.toml` 那 3 行取消註解，再 `bash scripts/deploy.sh`。
  未綁定期間 Worker／DO 判斷 `env.USAGE` 不存在即略過**每請求的 AE 計量點**（用量頁的 AE 指標為空）；DO 計數照樣經 Queue 寫入 D1，叫號功能不受影響。

- bindings 在 wrangler 中**不會從頂層繼承到 env**，每個 env 都要完整寫一份。頂層 `name = "call-api"` 不部署（腳本一律 `--env production`）。
- production **不得**有 `DEV_BYPASS_ACCESS`（帶此旗標時 Worker 拒絕運作）。
- Queue consumer 以佇列名稱判斷種類（`apps/api/src/index.ts`：名稱含 `push` 片段者為推播），本機 `qcs-push-local` 與正式 `call-push-production` 都適用。
- secrets（不寫進檔案，由 `bootstrap.sh` 設定）：`JWT_SECRET`、`PHONE_PEPPER`、`QR_ROOT_SECRET`、`VAPID_PRIVATE_KEY`、`VAPID_PUBLIC_KEY`、`VAPID_SUBJECT`、
  `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`、`ACCESS_ALLOWED_EMAILS`（Worker 再比一次名單，`apps/api/src/lib/access.ts`）、
  `CF_ACCOUNT_ID`、`AE_API_TOKEN`（用量計量查 AE SQL API，Account Analytics Read 唯讀；見 12-usage-metering）。`AE_DATASET` 是一般 var。
- Cron 以 **UTC** 執行。「每家店依自己時區換日」由每小時那支 cron 判斷「哪些門店的營業日剛結束」來處理。

## 4. 一鍵佈署設計

### 4.0 憑證與安全閘（共用帳號）

- 腳本**只讀** `~/.config/queue-call-system/cf.env`：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ZONE_ID`、`ACCESS_ALLOWED_EMAILS`
  （選填 `PUSH_CONTACT`、`AE_API_TOKEN`、`ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`）。權限必須是 `600`，否則拒絕執行。範本：`scripts/config.example.env`。
  腳本不印出任何值；這些變數不匯出給 pnpm／建置／測試等子行程。
- **不使用、不覆寫全域 `wrangler login`**：所有 wrangler 指令經 `cfw()`，`HOME` 與 `XDG_CONFIG_HOME` 指向每次執行的暫存目錄、token 以環境變數帶入、
  清掉 `CLOUDFLARE_API_KEY`／`CLOUDFLARE_EMAIL`。依據：wrangler 4.153 原始碼（`getAPIToken`：環境變數優先於已存 OAuth；
  全域設定目錄：`~/.wrangler` 存在則用之，否則 `XDG_CONFIG_HOME`）。其他版本的行為**未查證**；腳本優先用 repo 鎖定的 `apps/api/node_modules/.bin/wrangler`。
- **安全閘**：`assert_call_name`（`^call-[a-z0-9-]+$`）、`assert_call_host`（只允許 `call-*.jjoy.ai`）、`check_toml_names`（整段檢查 `[env.production]` 的
  Worker／D1／R2／Queue／DLQ／route／AE dataset）、`cf_api` 只允許 `/accounts/<本帳號>/…` 與 `/zones/<本 zone>/…`。自我測試 `scripts/lib.test.sh`（`pnpm test` 會跑）。

### 4.1 首次建置 `scripts/bootstrap.sh [production]`（可重複執行）

| 步驟 | 動作 | 冪等判斷 |
|---|---|---|
| 0 | 檢查工具、讀 cf.env、`cfw whoami` 確認 token 能存取該帳號、`check_toml_names`；**先印出資源計畫**（`print_plan`：全部資源與網域逐一過 `call-` 安全閘，任一不符整個中止，雲端什麼都還沒動） | 缺什麼直接中止並說明 |
| 1 | 建 D1 `call-db-production`，id 寫回 wrangler.toml 的 `__D1_ID_PRODUCTION__` | 已有同名 → 取既有 id；已填但不符 → 中止 |
| 2 | 建 KV `call-license-production`，id 寫回 `__KV_ID_PRODUCTION__`（在暫存目錄執行，**實測標題未被加前綴**，以標題找得到） | 同上 |
| 3 | 建 R2 `call-media-production`；設 CORS（§6.1，實測 wrangler 接受該 JSON）；綁自訂網域 `call-media.jjoy.ai`（`wrangler r2 bucket domain add`，實測成功）；**不開 r2.dev** | 已存在 → 跳過 |
| 4 | 建 Queues ×4（history、push、兩個 DLQ） | 已有 → 跳過 |
| 5 | 檢查 5 個 `apps/<app>/wrangler.toml` 的 production 名稱是 `call-<sub>-production`、網域是 `call-*.jjoy.ai`（前端 Worker 與 Custom Domain 由 deploy.sh 的 `wrangler deploy` 建立，ADR-050） | 只檢查 |
| 6 | D1 migration：`wrangler d1 migrations apply call-db-production --remote --env production` | wrangler 自己記錄 |
| 7 | 首次 `wrangler deploy --env production`（Worker、DO class、Queue consumer、Cron、`call-api` 自訂網域、`call-admin.jjoy.ai/api/*` route） | 重複 deploy 無副作用 |
| 8 | secrets：金鑰類（`JWT_SECRET`、`PHONE_PEPPER`、`QR_ROOT_SECRET`、`VAPID_*`）產生後設定、**已存在不覆蓋**（第二次執行實測印「已存在，不覆蓋」）；`VAPID_SUBJECT`；`CF_ACCOUNT_ID`、`AE_API_TOKEN` 同步（未提供則略過） | 金鑰類已有 → 不覆蓋 |
| 9 | （無需動作）網域：`call-api` 與 5 個前端由 wrangler.toml 的 `custom_domain` 在部署時建立 DNS 與憑證；`call-media` 見步驟 3。**沒有 CNAME 步驟** | — |
| 10 | Access（§7）：One-time PIN 登入方式（見下）、建應用 `call-admin`、policy `call-admin-allow`（Allow `ACCESS_ALLOWED_EMAILS`），再把 `ACCESS_AUD`／`ACCESS_TEAM_DOMAIN`／`ACCESS_ALLOWED_EMAILS` 設為 Worker secrets。名單空白則略過；API 失敗則印出 dashboard 步驟 | 已有同名應用 → 沿用（網域不符則中止）；policy 以名稱 `call-admin-allow` 更新 |
| 11 | （無需動作）語音包隨 `call-display` 前端 Worker 部署上線（ADR-026）；只檢查檔數 < 15,000 | — |
| 12 | 預設品牌、smoke 門店 `store_smoke`（門店碼 `SMOKE0`）＋ smoke 店長、平台管理員（`ACCESS_ALLOWED_EMAILS`）。smoke 店長帳密首次產生到 `~/.config/queue-call-system/smoke.json`（600），供 `smoke-ws.mjs` 使用 | 品牌／門店／管理員 `INSERT OR IGNORE`；smoke 店長以 smoke.json 的密碼 UPSERT |
| 13 | 執行 `scripts/deploy.sh` 完成第一次完整部署；`SKIP_DEPLOY=1` 時略過 | — |

- **Access team domain**：token 沒有 Access Organizations 讀取權限，所以實測走第三條路——在 `call-admin.jjoy.ai` 存在後，讀未登入請求的 302 導向
  （`https://<team>.cloudflareaccess.com/…`）取得。首次執行時 call-admin 網域要等步驟 13 的部署才建立，所以**首次部署完成後再跑一次 `bootstrap.sh`**
  才會寫入 `ACCESS_TEAM_DOMAIN`（也可在 cf.env 直接填 `ACCESS_TEAM_DOMAIN`）。
- **One-time PIN**：token 缺「Access: Organizations, Identity Providers, and Groups Edit」，無法以 API 建立明確的 OTP 登入方式，bootstrap 印 `•` 提示後繼續；
  實測 call-admin 的 Access 登入頁已顯示「Email → Send login code」（OTP 為預設登入方式），自動化測試截到此頁為止。以名單內 email 實際收碼登入：**待人工驗證**。

### 4.2 日常部署 `scripts/deploy.sh [production]`

```
0. 讀 cf.env、驗 token、check_toml_names、印出資源計畫（call- 安全閘）；wrangler.toml 仍有 D1／KV 佔位 → 中止（請先 bootstrap）
1. pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm test && pnpm e2e   （失敗即停，雲端什麼都沒動；SKIP_E2E=1 可略過 e2e）
2. 記下目前 API Worker 版本 → PREV_VERSION
   （wrangler deployments list --json 由舊到新排序，2026-10-27 實測；取最後一筆＝目前生效版本）
3. D1 migration（只允許向下相容的 migration）
4. wrangler deploy --env production --var VERSION:<git sha>；同步 ACCESS_ALLOWED_EMAILS secret（名單改了只要改 cf.env 再部署）
5. 5 個前端：VITE_API_BASE=https://call-api.jjoy.ai（call-admin 為空字串＝同源 /api，ADR-047）、VITE_AUDIO_BASE=https://call-display.jjoy.ai/audio/、
   VITE_STORE_BASE=https://call-store.jjoy.ai → pnpm --filter @qcs/<app> build --mode production
   → （在 apps/<app>）wrangler deploy --env production --message "deploy.sh <git sha>"   ← assets-only Worker call-<sub>-production（ADR-050）
6. scripts/smoke.sh（在正式網址驗證，只發 HTTPS 請求、不讀 cf.env）：
   a. GET https://call-api.jjoy.ai/health → 200 且 {version} 等於本次 commit
   b. WebSocket（scripts/smoke-ws.mjs）：smoke 店長登入 → 連 /ws/store/store_smoke → 收到 hello，送 ping 收到 pong
   c. 5 個前端首頁 → 200；call-admin 未登入 → 302（Access；回 200 只警示「Access 尚未設定」）
   d. https://call-admin.jjoy.ai/api/admin/me 未登入 → 被擋（實測 302）
   e. https://call-api.jjoy.ai/api/admin/me（API 網域沒有 Access）→ 必須 401
   f. call-media 對 call-display 的 CORS 預檢有 allow-origin（缺少只警示）
7. smoke 失敗 → wrangler rollback <PREV_VERSION>（只回滾 API Worker；前端與 D1 不回滾）並以非 0 結束
8. smoke 通過後：（選用）pnpm e2e:prod；依 docs/10 C 段在正式網址做手機／電視實機驗證
```

- **實測紀錄（2026-10-27）**：一次部署 smoke 的 WebSocket 檢查失敗，deploy.sh 自動 `wrangler rollback` 到 PREV_VERSION，行為符合設計。
  教訓：bootstrap 步驟 7 建出的**第一個 Worker 版本在 `secret put` 之前**，不含任何 secret——**永遠不要回滾到那個最初版本**（JWT／QR 金鑰都會缺）。
  deploy.sh 取的 PREV_VERSION 是「目前生效版本」，正常情況不會是它；手動 `rollback.sh <version-id>` 時要自己避開。
- 順序是刻意的：**先 migration 再 Worker**——因為 migration 只做向下相容（加表／加欄），舊 Worker 碰到新 schema 不會壞，所以 Worker 回滾永遠安全。
- smoke 門店：bootstrap 建一家 `store_smoke`（門店碼 `SMOKE0`，`features.internal`，不在總後台列表顯示）＋ smoke 店長，專供部署驗證。

### 4.3 回滾 `scripts/rollback.sh [production] [version-id] [--frontends]`

| 對象 | 方式 |
|---|---|
| API Worker（含 DO 程式碼、Queue consumer、Cron） | `bash scripts/rollback.sh production [version-id]` → `wrangler rollback [version-id] --env production`；不帶 id 回到上一版。version-id 用 `wrangler versions list` 查 |
| 前端 Worker（5 個） | 加 `--frontends`：每個 `call-<sub>-production` 各自 `wrangler rollback` 回到**上一版**（不能指定版本）。dashboard：Workers & Pages → `call-<sub>-production` → Deployments |
| D1 | **不回滾 schema**。資料出錯用 D1 Time Travel（30 天）還原到時間點：`wrangler d1 time-travel restore call-db-production --timestamp <ISO>`（指令細節**未查證**） |
| DO class | 不可回滾刪除／改名；所以 DO 的 schema 變更一律在 DO 內以 `user_version` 向前遷移，程式碼要能讀舊格式 |

**回滾演練（2026-10-27）**：部署 `33b408e` 後執行 `rollback.sh production <version-id>` → `/health` 回 `22f40c1`，smoke 6/6 通過；
前端回滾以 `call-staff` 實測；之後再跑 `deploy.sh` 前滾回最新版。回滾後 `/health` 的版本會與 HEAD 不同，**直接跑 smoke.sh 會因版本不符失敗**——
要驗回滾版本時用 `GIT_SHA=<該版 sha> bash scripts/smoke.sh`（smoke.sh 優先讀 `GIT_SHA`）。

### 4.4 CI

- `.github/workflows/ci.yml`：每次 push／PR 跑 hibernation 靜態檢查＋型別檢查＋`pnpm test`（不部署）。
- **不做 CI 自動部署**（ADR-049）：憑證只放在業主電腦的 `~/.config/queue-call-system/cf.env`，部署由人在本機執行 `scripts/deploy.sh`。
  日後若要 CI 部署，需另立 ADR（token 放 GitHub environment secret、加人工核准）。

### 4.5 API Token 最小權限（cf.env 的 `CLOUDFLARE_API_TOKEN`）

2026-10-27 首次部署實際使用的 token 權限如下（bootstrap、deploy、seed、rollback 全部成功）：

| 範圍 | 權限 | 用途 |
|---|---|---|
| Account | Workers Scripts Write | API Worker、5 個前端 Worker、secrets、rollback |
| Account | D1 Write | 建庫、migration、seed |
| Account | Workers KV Storage Write | 門店快取 namespace |
| Account | Workers R2 Storage Write | bucket、CORS、自訂網域、上傳素材 |
| Account | Queues Write | 4 個 Queue |
| Account | Account Settings Read | `wrangler whoami` 驗證帳號 |
| Account | Access: Apps and Policies Edit | 建 Access 應用 `call-admin`、policy `call-admin-allow`、讀 AUD |
| Account | Cloudflare Pages Write | **已不需要**（ADR-050 改用 Worker）；token 上留著無害 |
| Zone（只選 jjoy.ai） | Workers Routes Write | `call-admin.jjoy.ai/api/*` route、Custom Domains |
| Zone（只選 jjoy.ai） | DNS Write | Worker／R2 自訂網域的 DNS 紀錄 |

**缺少但不阻擋**（bootstrap 印 `•` 提示後繼續）：

| 權限 | 缺少時的影響與替代 |
|---|---|
| Access: Organizations, Identity Providers, and Groups Read／Edit | 讀不到 team domain → 改由 call-admin 的 Access 登入導向取得（§4.1）；無法建立明確的 One-time PIN 登入方式 → 實測登入頁已預設提供 email 驗證碼 |
| Account Analytics Read（另一支唯讀 token `AE_API_TOKEN`，存成 Worker secret） | 未提供：用量頁不查 AE SQL API；且 AE 本身尚未啟用（§3） |

權限名稱依 2026-10-27 查證之 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)，Access 權限以 dashboard 顯示名稱為準。
token 是帳號層級權限，無法限制到 `call-` 資源——隔離靠腳本安全閘，所以不要把這支 token 用在其他地方。

## 5. D1 migration 規則

- 只能：`CREATE TABLE`、`ALTER TABLE ADD COLUMN`（nullable 或有 DEFAULT）、`CREATE INDEX`。
- 禁止：`DROP`、`RENAME`、改欄位型別。要淘汰欄位：先在程式不再讀寫（一個以上版本），之後另案清理。
- 每支 migration 檔名遞增 `NNNN_描述.sql`，進 code review。

## 6. 網域

1. `jjoy.ai` 已在 Cloudflare 託管（共用 zone；只新增 `call-*` 紀錄，不動其他紀錄）。
2. API Worker `call-api.jjoy.ai`：由 `apps/api/wrangler.toml` 的 `custom_domain = true` 在 `wrangler deploy` 時自動建立 DNS 與憑證。
3. 前端 5 個子網域 `call-admin`／`call-store`／`call-staff`／`call-display`／`call-q`：同樣由各自 `apps/<app>/wrangler.toml` 的 Custom Domain 在
   deploy.sh 的 `wrangler deploy --env production` 時建立（ADR-050，實測成功）。**不需要 Pages 網域 API，也沒有手動 CNAME 步驟**。
   wrangler 會拒絕覆蓋既有的同名 DNS 紀錄，所以不會動到別的產品。
4. R2 `call-media.jjoy.ai`：bootstrap 以 `wrangler r2 bucket domain add call-media-production --domain call-media.jjoy.ai --zone-id <CF_ZONE_ID>` 綁定（實測成功）；
   **不開 r2.dev 公開網址**（不執行 `r2 bucket dev-url enable`）。

### 6.1 媒體（R2）的 CORS 與快取

- **CORS**（bootstrap 以 `wrangler r2 bucket cors set` 設定；`rules[].allowed.origins/methods/headers`、`maxAgeSeconds` 的 JSON 格式實測被接受）：允許 `GET`、`HEAD`，來源只有
  `https://call-display.jjoy.ai`、`https://call-store.jjoy.ai`、`https://call-admin.jjoy.ai`、`https://call-q.jjoy.ai`；允許 `Range` 標頭（影片續播）。
- **物件已內容定址**：廣告 key 為 `ads/<owner>/<sha256>.<ext>`（`apps/api/src/routes/ads.ts`），上傳時寫入
  `Cache-Control: public, max-age=31536000, immutable`。內容變了檔名就變，所以可以快取一年、不需要清快取。
- **Cache Rule（手動，一次）**：dashboard → jjoy.ai → Caching → Cache Rules → Create rule：
  - 名稱 `call-media long cache`；When：Hostname equals `call-media.jjoy.ai`
  - Cache eligibility：Eligible for cache；Edge TTL：Use cache-control header if present（或 Override 1 year）；Browser TTL：Respect origin
  - 不以腳本建立：Rulesets API 以 PUT 寫 entrypoint 會**覆寫整個 zone 的 cache rules**（同 zone 還有其他產品），風險大於手動一次的成本。
  - R2 自訂網域在沒有 Cache Rule 時預設是否快取 mp4 等副檔名：**未查證**，所以明訂此規則。
  - **狀態（2026-10-27）**：Cache Rule **尚未建立**（仍待手動）；建立前實測回應為 `cf-cache-status: MISS`。
- **實測（2026-10-27）**：`https://call-media.jjoy.ai/ads/<storeId>/<sha256>.jpg` → 200、`cache-control: public, max-age=31536000, immutable`；
  帶 `Origin: https://call-display.jjoy.ai` 回 `access-control-allow-origin: https://call-display.jjoy.ai`，帶 `Origin: https://example.org` 不回 allow-origin。
- 驗證步驟見 docs/10 步驟 12（開廣告網址看標頭、從 call-display 檢查 CORS）。

## 7. 總後台 Cloudflare Access（ADR-047、ADR-049）

1. Access 應用 **`call-admin`**（Self-hosted），Application domain：`call-admin.jjoy.ai`（**整個 host**，含同源 `/api/*`）。
2. Policy `call-admin-allow`：Allow → Emails → `ACCESS_ALLOWED_EMAILS`（cf.env，逗號分隔；業主之後提供名單；≤ 50 人免費）。
3. Login method：**One-time PIN**（email 驗證碼），不接 IdP——多位主管用公司信箱直接登入（決策者：業主）。
   實況（2026-10-27）：token 無權建立明確的 OTP 登入方式，但 call-admin 的 Access 登入頁已顯示「Email → Send login code」（預設 OTP）。
   名單內 email 實際收碼登入：**待人工驗證**。
4. Worker secrets：`ACCESS_AUD`（Application Audience Tag）、`ACCESS_TEAM_DOMAIN`（`<team>.cloudflareaccess.com`）、`ACCESS_ALLOWED_EMAILS`。
   Worker 對 `/api/admin/*` 驗 `Cf-Access-Jwt-Assertion`（簽章、aud、iss），並**再比一次 email 名單**（`apps/api/src/lib/access.ts`）：
   即使有人繞過 Access 直打 `call-api.jjoy.ai/api/admin/*` 也會因沒有有效 JWT 被擋。
5. **API 路由（ADR-047）**：總後台 SPA 呼叫**同源** `/api/admin/*`（建置時 `VITE_API_BASE` 為空）。Worker 除了 `call-api.jjoy.ai` 自訂網域，
   另加 route `call-admin.jjoy.ai/api/*` → `call-api-production`，讓請求經過 call-admin 前面的 Access、自動帶 JWT。其他 SPA 用 `VITE_API_BASE=https://call-api.jjoy.ai`。
   - **已查證＋實測**：同一 hostname 的 Worker route 優先於 Custom Domain（[custom-domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)，ADR-050）。
     正式網址實測：`call-admin.jjoy.ai/api/admin/me` 未登入 302 到 Access（smoke d），`call-api.jjoy.ai/api/admin/me` 回 401（smoke e）。
     原規劃的「Pages Function 代理」備援已不需要（前端已不是 Pages）。

## 7.5 叫號機 Android 包裝 App（`apps/display-android`，ADR-027）

| 項目 | 規格 |
|---|---|
| 內容 | 單一 Activity＋全螢幕 WebView，只載入 `https://call-display.jjoy.ai/`（網址寫在 App 設定；只有 production 一個環境，ADR-049） |
| 自動出聲 | `webView.settings.mediaPlaybackRequiresUserGesture = false`；另開 `javaScriptEnabled`、`domStorageEnabled`（Service Worker／Cache Storage 需要） |
| 開機自啟 | 註冊為 **HOME launcher**（`intent-filter` 含 `category.HOME`），開機即進入 App；另加 `BOOT_COMPLETED` receiver 作輔助。Android 10 起限制從背景啟動 Activity，所以以 launcher 為主（限制細節**未查證**，M8 實測） |
| Kiosk | immersive 全螢幕（隱藏系統列）；可選 Lock Task mode（需設為 device owner，用 `adb shell dpm set-device-owner` 一次設定） |
| 螢幕常亮 | `FLAG_KEEP_SCREEN_ON` |
| 斷網重連 | `ConnectivityManager.NetworkCallback` 網路恢復時通知網頁（網頁本身已有 WS 重連）；主頁載入失敗時 10 秒後重試 |
| 模式標記 | userAgent 附加 `QueueDisplayApp/<x.y>`（`settings.userAgentString += ...`）＋ JS bridge `QCSNative.info()` 回傳 `{client:"android_app", appVersion}`；display 前端據此進入 app 模式，**完全不顯示「啟用聲音」提示** |
| 遙控器 | 首次啟動即為正式網址；設定畫面以 D-pad 可聚焦按鈕操作，不需文字輸入 |
| 更新 | 網頁更新免重裝（App 只是外殼）；App 本身極少更新，以 APK 側載或 MDM 發佈 |
| 安全 | 只允許導覽到 `call-display.jjoy.ai` 與 `call-media.jjoy.ai`，其他網址一律攔截 |

> `setMediaPlaybackRequiresUserGesture`：Android 官方 API 頁本次無法取得內容，API 細節（加入版本、預設值）**未查證**，以 M8 實機為準。
> Chrome `--autoplay-policy=no-user-gesture-required` 與企業政策 `AutoplayAllowed`／`AutoplayAllowlist` 見於 [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay)（文章 2017 年更新，**目前是否仍有效未查證**）。

## 8. 監控

| 指標 | 看哪裡 | 正常值／警示 |
|---|---|---|
| **DO Duration（GB-s）** | Dashboard → Workers → Durable Objects → Metrics（或 GraphQL `durableObjectsPeriodicGroups`） | **非營業時間應趨近 0**；夜間有固定斜率＝有 DO 沒 hibernate（查 `setTimeout`、`ws.accept`、外部 fetch） |
| DO requests ÷ 當日號碼數 | 總後台用量頁 | 4～10；> 20 表示輪詢或心跳誤用 |
| Worker 錯誤率 | Workers Observability | > 1% 警示 |
| Queue backlog／DLQ | Queues dashboard | backlog 應趨近 0；DLQ 有訊息即查 |
| D1 大小 | `wrangler d1 info` | > 7 GB 啟動對策（03-data-model §5） |
| 每店異常 | 總後台「用量與成本」警示 | 見 12-usage-metering |
| 叫號機無法出聲 | `devices.audio_status = 'blocked'` | 門店後台與總後台警示；多半是一般瀏覽器未點擊、或 kiosk 設定遺失 |

## 9. 資料保留 Cron（`30 19 * * *` UTC）

```
DELETE FROM tickets_history    WHERE ended_at   < now - 90d
DELETE FROM push_subscriptions WHERE created_at < now - 24h
DELETE FROM audit_logs         WHERE at         < now - 365d
DELETE FROM usage_hourly       WHERE hour_start < now - 35d     （見 12-usage-metering）
```

每批以 `LIMIT 5000` 分次刪除，避免單次查詢過久。

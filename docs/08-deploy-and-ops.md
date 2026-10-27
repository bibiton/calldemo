# 08 — 部署與維運

> 本章的腳本在 `scripts/` 是**草稿，尚未對 Cloudflare 實測**。實作與實測列在 [09-roadmap](09-roadmap.md) M6。
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
│  ├─ display-android/          叫號機 Android WebView 包裝 App（Kotlin，ADR-027）
├─ packages/shared/             型別、WS 協定、mask、phone、qr-token
├─ assets/audio/                預錄語音素材 + manifest.json（建置時複製進 apps/display/public/audio，隨 Pages 部署）
└─ scripts/                     bootstrap.sh deploy.sh rollback.sh smoke.sh lib.sh lib.test.sh
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
| Analytics Engine | 不綁 | `call_usage_production`（AE dataset 名只能用底線） |
| Pages | `pnpm dev`（Vite 517x） | `call-admin-production`、`call-store-production`、`call-staff-production`、`call-display-production`、`call-q-production` |
| Access 應用 | `DEV_BYPASS_ACCESS=1` | `call-admin` |

| 子網域（`.jjoy.ai`） | 指向 | 保護 |
|---|---|---|
| `call-admin` | Pages `call-admin-production`；`/api/*` 由 Worker route 接手（§7） | Cloudflare Access（整個 host） |
| `call-store` | Pages `call-store-production` | 帳密＋JWT |
| `call-staff` | Pages `call-staff-production` | 裝置綁店＋PIN |
| `call-display` | Pages `call-display-production` | 裝置配對 |
| `call-q` | Pages `call-q-production`（apps/customer） | 動態 QR token |
| `call-api` | Worker `call-api-production`（custom domain） | 依路由 |
| `call-media` | R2 `call-media-production`（自訂網域；**不開 r2.dev**） | 公開唯讀、檔名含 SHA-256 |

- `[env.local]` 的 `qcs-*-local` 名稱**不改**（Vitest、E2E、`seed-local.mjs` 依賴；不會建立任何雲端資源）。
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

[[env.production.d1_databases]]          # database_name = "call-db-production"，database_id = "__D1_ID_PRODUCTION__"（bootstrap 填入）
[[env.production.kv_namespaces]]         # id = "__KV_ID_PRODUCTION__"（bootstrap 填入）
[[env.production.r2_buckets]]            # bucket_name = "call-media-production"
[[env.production.queues.producers]]      # call-history-production、call-push-production
[[env.production.queues.consumers]]      # 同上，dead_letter_queue = call-*-dlq-production
[[env.production.analytics_engine_datasets]]   # binding USAGE → dataset call_usage_production
[env.production.triggers]                # crons = ["5 * * * *", "30 19 * * *"]
```

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
| 0 | 檢查工具、讀 cf.env、`cfw whoami` 確認 token 能存取該帳號、`check_toml_names` | 缺什麼直接中止並說明 |
| 1 | 建 D1 `call-db-production`，id 寫回 `__D1_ID_PRODUCTION__` | 已有同名 → 取既有 id；已填但不符 → 中止 |
| 2 | 建 KV `call-license-production`，id 寫回 `__KV_ID_PRODUCTION__` | 同上 |
| 3 | 建 R2 `call-media-production`；設 CORS（§6.1）；綁自訂網域 `call-media.jjoy.ai`（`wrangler r2 bucket domain add`，權限不足時印出 dashboard 步驟）；**不開 r2.dev** | 已存在 → 跳過 |
| 4 | 建 Queues ×4（history、push、兩個 DLQ） | 已有 → 跳過 |
| 5 | 建 5 個 Pages 專案 `call-<sub>-production --production-branch main` | 已有 → 跳過 |
| 6 | D1 migration：`wrangler d1 migrations apply call-db-production --remote --env production` | wrangler 自己記錄 |
| 7 | 首次 `wrangler deploy --env production`（Worker、DO class、Queue consumer、Cron、`call-api` 自訂網域、`call-admin.jjoy.ai/api/*` route） | 重複 deploy 無副作用 |
| 8 | secrets：金鑰類（`JWT_SECRET`、`PHONE_PEPPER`、`QR_ROOT_SECRET`、`VAPID_*`）產生後設定、**已存在不覆蓋**；`CF_ACCOUNT_ID`、`AE_API_TOKEN` 同步 | 金鑰類已有 → 不覆蓋 |
| 9 | Pages 自訂網域（Pages API `POST /accounts/<id>/pages/projects/<p>/domains`，**未查證**）＋ DNS CNAME `call-<sub>` → `<p>.pages.dev`（Proxied） | 已綁 → 跳過；DNS 已存在且指向別處 → **不修改**，提示人工確認 |
| 10 | Access（§7）：啟用 One-time PIN、建應用 `call-admin`、policy Allow `ACCESS_ALLOWED_EMAILS`，再把 AUD／team domain／名單設為 Worker secrets。名單空白則略過；API 失敗則印出 dashboard 步驟 | 已有同名應用 → 沿用（網域不符則中止）；policy 以名稱 `call-admin-allow` 更新 |
| 11 | （無需動作）語音包隨 `call-display` 的 Pages 部署上線（ADR-026）；只檢查檔數 < 15,000 | — |
| 12 | 預設品牌、smoke 門店、平台管理員（`ACCESS_ALLOWED_EMAILS`）：`INSERT OR IGNORE` | `INSERT OR IGNORE` |
| 13 | 執行 `scripts/deploy.sh` 完成第一次完整部署 | — |

### 4.2 日常部署 `scripts/deploy.sh [production]`

```
1. pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm test && pnpm e2e   （失敗即停，雲端什麼都沒動；SKIP_E2E=1 可略過 e2e）
2. 記下目前 Worker 版本 → PREV_VERSION
3. D1 migration（只允許向下相容的 migration）
4. wrangler deploy --env production --var VERSION:<git sha>；同步 ACCESS_ALLOWED_EMAILS secret（名單改了只要改 cf.env 再部署）
5. 5 個前端：VITE_API_BASE=https://call-api.jjoy.ai（call-admin 為空字串＝同源 /api，ADR-047）、VITE_AUDIO_BASE=https://call-display.jjoy.ai/audio/、
   VITE_STORE_BASE=https://call-store.jjoy.ai → pnpm --filter @qcs/<app> build --mode production
   → wrangler pages deploy apps/<app>/dist --project-name call-<sub>-production --branch main
6. scripts/smoke.sh（在正式網址驗證）：
   a. GET https://call-api.jjoy.ai/health → 200 且 {version} 等於本次 commit
   b. WebSocket：smoke 門店 ping → pong＋hello（scripts/smoke-ws.mjs 尚未撰寫，缺檔時略過並提示）
   c. 5 個前端首頁 → 200；call-admin 未登入 → 302（Access；回 200 只警示「Access 尚未設定」）
   d. https://call-admin.jjoy.ai/api/admin/me 未登入 → 302／401／403
   e. call-media 對 call-display 的 CORS 預檢（只警示）
7. smoke 失敗 → wrangler rollback <PREV_VERSION>（只回滾 Worker；D1 不回滾，見 §5）並以非 0 結束
8. smoke 通過後：依 docs/10 C 段在正式網址做手機／電視實機驗證
```

- 順序是刻意的：**先 migration 再 Worker**——因為 migration 只做向下相容（加表／加欄），舊 Worker 碰到新 schema 不會壞，所以 Worker 回滾永遠安全。
- smoke 門店：bootstrap 建一家 `smoke` 測試門店（不在總後台列表顯示），專供部署驗證。

### 4.3 回滾 `scripts/rollback.sh [production] [version-id]`

| 對象 | 方式 |
|---|---|
| Worker（含 DO 程式碼、Queue consumer、Cron） | `wrangler rollback [version-id] --env production`；不帶 id 回到上一版 |
| Pages | dashboard → `call-<sub>-production` → Deployments → 選上一個 → Rollback（Pages API 的 rollback 端點**未查證**） |
| D1 | **不回滾 schema**。資料出錯用 D1 Time Travel（30 天）還原到時間點：`wrangler d1 time-travel restore call-db-production --timestamp <ISO>`（指令細節**未查證**） |
| DO class | 不可回滾刪除／改名；所以 DO 的 schema 變更一律在 DO 內以 `user_version` 向前遷移，程式碼要能讀舊格式 |

### 4.4 CI

- `.github/workflows/ci.yml`：每次 push／PR 跑 hibernation 靜態檢查＋型別檢查＋`pnpm test`（不部署）。
- **不做 CI 自動部署**（ADR-049）：憑證只放在業主電腦的 `~/.config/queue-call-system/cf.env`，部署由人在本機執行 `scripts/deploy.sh`。
  日後若要 CI 部署，需另立 ADR（token 放 GitHub environment secret、加人工核准）。

### 4.5 API Token 最小權限（cf.env 的 `CLOUDFLARE_API_TOKEN`）

**部署（deploy.sh）必要**

| 範圍 | 權限 |
|---|---|
| Account | Workers Scripts Write |
| Account | D1 Write |
| Account | Workers KV Storage Write |
| Account | Workers R2 Storage Write |
| Account | Queues Write |
| Account | Cloudflare Pages Write |
| Account | Account Settings Read |
| Zone（只選 jjoy.ai） | Workers Routes Write（`call-admin.jjoy.ai/api/*` route） |
| Zone（只選 jjoy.ai） | DNS Write（Worker／R2／Pages 自訂網域需要建 DNS 紀錄） |

**bootstrap 自動設定 Access 時另需**：Access: Apps and Policies Write、Access: Organizations, Identity Providers, and Groups Write（啟用 One-time PIN、讀 team domain）。
沒有這些權限時 bootstrap 改印手動步驟，不會失敗。**用量計量**（`AE_API_TOKEN`，另一支唯讀 token，存成 Worker secret）：Account Analytics Read。

權限名稱依 2026-10-27 查證之 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)；
Access 相關權限的確切顯示名稱**未查證**，以 dashboard 畫面為準。token 是帳號層級權限，無法限制到 `call-` 資源——隔離靠腳本安全閘，所以不要把這支 token 用在其他地方。

## 5. D1 migration 規則

- 只能：`CREATE TABLE`、`ALTER TABLE ADD COLUMN`（nullable 或有 DEFAULT）、`CREATE INDEX`。
- 禁止：`DROP`、`RENAME`、改欄位型別。要淘汰欄位：先在程式不再讀寫（一個以上版本），之後另案清理。
- 每支 migration 檔名遞增 `NNNN_描述.sql`，進 code review。

## 6. 網域

1. `jjoy.ai` 已在 Cloudflare 託管（共用 zone；只新增 `call-*` 紀錄，不動其他紀錄）。
2. Worker `call-api.jjoy.ai`：由 `wrangler.toml` 的 `custom_domain = true` 自動建立 DNS 與憑證。
3. Pages 5 個子網域：bootstrap 以 Pages API 綁定並建 CNAME（端點**未查證**；失敗時 dashboard：Pages 專案 → Custom domains）。
4. R2 `call-media.jjoy.ai`：bootstrap 以 `wrangler r2 bucket domain add call-media-production --domain call-media.jjoy.ai --zone-id <CF_ZONE_ID>`
   （wrangler 4.153 `--help` 已確認有此指令與參數）；**不開 r2.dev 公開網址**（不執行 `r2 bucket dev-url enable`）。

### 6.1 媒體（R2）的 CORS 與快取

- **CORS**（bootstrap 以 `wrangler r2 bucket cors set` 設定；JSON 欄位格式**未查證**）：允許 `GET`、`HEAD`，來源只有
  `https://call-display.jjoy.ai`、`https://call-store.jjoy.ai`、`https://call-admin.jjoy.ai`、`https://call-q.jjoy.ai`；允許 `Range` 標頭（影片續播）。
- **物件已內容定址**：廣告 key 為 `ads/<owner>/<sha256>.<ext>`（`apps/api/src/routes/ads.ts`），上傳時寫入
  `Cache-Control: public, max-age=31536000, immutable`。內容變了檔名就變，所以可以快取一年、不需要清快取。
- **Cache Rule（手動，一次）**：dashboard → jjoy.ai → Caching → Cache Rules → Create rule：
  - 名稱 `call-media long cache`；When：Hostname equals `call-media.jjoy.ai`
  - Cache eligibility：Eligible for cache；Edge TTL：Use cache-control header if present（或 Override 1 year）；Browser TTL：Respect origin
  - 不以腳本建立：Rulesets API 以 PUT 寫 entrypoint 會**覆寫整個 zone 的 cache rules**（同 zone 還有其他產品），風險大於手動一次的成本。
  - R2 自訂網域在沒有 Cache Rule 時預設是否快取 mp4 等副檔名：**未查證**，所以明訂此規則。
- 驗證步驟見 docs/10 步驟 12（開廣告網址看標頭、從 call-display 檢查 CORS）。

## 7. 總後台 Cloudflare Access（ADR-047、ADR-049）

1. Access 應用 **`call-admin`**（Self-hosted），Application domain：`call-admin.jjoy.ai`（**整個 host**，含同源 `/api/*`）。
2. Policy `call-admin-allow`：Allow → Emails → `ACCESS_ALLOWED_EMAILS`（cf.env，逗號分隔；業主之後提供名單；≤ 50 人免費）。
3. Login method：**One-time PIN**（email 驗證碼），不接 IdP——多位主管用公司信箱直接登入（決策者：業主）。
4. Worker secrets：`ACCESS_AUD`（Application Audience Tag）、`ACCESS_TEAM_DOMAIN`（`<team>.cloudflareaccess.com`）、`ACCESS_ALLOWED_EMAILS`。
   Worker 對 `/api/admin/*` 驗 `Cf-Access-Jwt-Assertion`（簽章、aud、iss），並**再比一次 email 名單**（`apps/api/src/lib/access.ts`）：
   即使有人繞過 Access 直打 `call-api.jjoy.ai/api/admin/*` 也會因沒有有效 JWT 被擋。
5. **API 路由（ADR-047）**：總後台 SPA 呼叫**同源** `/api/admin/*`（建置時 `VITE_API_BASE` 為空）。Worker 除了 `call-api.jjoy.ai` 自訂網域，
   另加 route `call-admin.jjoy.ai/api/*` → `call-api-production`，讓請求經過 call-admin 前面的 Access、自動帶 JWT。其他 SPA 用 `VITE_API_BASE=https://call-api.jjoy.ai`。
   - **未查證**：同一 host 上「Worker route 優先於 Pages 自訂網域」。部署後以 `curl -I https://call-admin.jjoy.ai/api/health`（登入後）確認回應來自 Worker。
   - **備援**：若 route 不生效，在 admin Pages 專案加一支極小的 Pages Function（`functions/api/[[path]].ts`）把 `/api/*` 轉送到 `https://call-api.jjoy.ai`，
     並原樣帶上 `Cf-Access-Jwt-Assertion`；此時刪除 wrangler.toml 的 `call-admin.jjoy.ai/api/*` route。

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

# 08 — 部署與維運

> 本章的腳本在 `scripts/` 只有**草稿，未實測**。實作與實測列在 [09-roadmap](09-roadmap.md) M6。
> 業主版的逐步教學見 [10-deploy-guide-for-owner](10-deploy-guide-for-owner.md)。本機開發與測試見 [11-local-testing](11-local-testing.md)。

## 1. Monorepo

```
queue-call-system/
├─ pnpm-workspace.yaml          packages: ["apps/*", "packages/*"]
├─ package.json                 scripts: dev / test / build / deploy:staging / deploy:production
├─ apps/
│  ├─ api/                      Worker（Hono）+ StoreQueueDO + queue consumer + scheduled
│  │  ├─ wrangler.toml
│  │  ├─ migrations/            D1 migration（0001_init.sql ...）
│  │  └─ src/
│  ├─ admin/ store/ staff/ display/ customer/    Vite + React + Tailwind
├─ packages/shared/             型別、WS 協定、mask、phone、qr-token
├─ assets/audio/                預錄語音素材 + manifest.json（部署時上傳 R2）
└─ scripts/                     bootstrap.sh deploy.sh rollback.sh smoke.sh lib.sh
```

## 2. 環境

| | staging | production |
|---|---|---|
| Worker | `qcs-api-staging` | `qcs-api` |
| D1 | `qcs-db-staging` | `qcs-db` |
| KV | `qcs-license-staging` | `qcs-license` |
| R2 | `qcs-media-staging` | `qcs-media` |
| Queues | `qcs-history-staging`、`qcs-push-staging`（＋各自 DLQ） | `qcs-history`、`qcs-push`（＋DLQ） |
| Analytics Engine | `qcs_usage_staging` | `qcs_usage` |
| Pages | `qcs-<app>-staging`（或同專案 preview branch，見下） | `qcs-<app>` |
| 網域 | `*.staging.<domain>` | `*.<domain>` |

資源**各自獨立**，staging 的錯誤不會寫進 production 資料。
Pages：採**每環境一個專案**（10 個專案，帳號上限 100），讓 staging 與 production 的自訂網域與環境變數完全分開。

## 3. `apps/api/wrangler.toml`（範例）

```toml
name = "qcs-api"
main = "src/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

# DO class 只能新增；刪除／改名不可逆，必須另寫 deleted_classes / renamed_classes migration 並人工審核
[[migrations]]
tag = "v1"
new_sqlite_classes = ["StoreQueueDO"]

[observability]
enabled = true

# ---------- staging ----------
[env.staging]
name = "qcs-api-staging"
routes = [{ pattern = "api.staging.example.com", custom_domain = true }]
vars = { ENV = "staging", APP_ORIGINS = "https://q.staging.example.com,https://staff.staging.example.com,https://display.staging.example.com,https://store.staging.example.com,https://admin.staging.example.com", MEDIA_BASE = "https://media.staging.example.com" }

[[env.staging.d1_databases]]
binding = "DB"
database_name = "qcs-db-staging"
database_id = "__D1_ID_STAGING__"          # bootstrap.sh 會填入
migrations_dir = "migrations"

[[env.staging.kv_namespaces]]
binding = "LICENSE"
id = "__KV_ID_STAGING__"

[[env.staging.r2_buckets]]
binding = "MEDIA"
bucket_name = "qcs-media-staging"

[[env.staging.durable_objects.bindings]]
name = "STORE_QUEUE"
class_name = "StoreQueueDO"

[[env.staging.queues.producers]]
binding = "Q_HISTORY"
queue = "qcs-history-staging"
[[env.staging.queues.producers]]
binding = "Q_PUSH"
queue = "qcs-push-staging"

[[env.staging.queues.consumers]]
queue = "qcs-history-staging"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 5
dead_letter_queue = "qcs-history-dlq-staging"
[[env.staging.queues.consumers]]
queue = "qcs-push-staging"
max_batch_size = 25
max_batch_timeout = 2           # 叫號推播要快
max_retries = 3
dead_letter_queue = "qcs-push-dlq-staging"

[[env.staging.analytics_engine_datasets]]
binding = "USAGE"
dataset = "qcs_usage_staging"

[env.staging.triggers]
crons = ["5 * * * *", "30 19 * * *"]   # 每小時：門店時區換日彙總；UTC 19:30 = 台灣 03:30：保留清理

# ---------- production：同上結構，名稱去掉 -staging、ID 佔位為 __*_PRODUCTION__ ----------
[env.production]
name = "qcs-api"
routes = [{ pattern = "api.example.com", custom_domain = true }]
# ...（同 staging，略）
```

- bindings 在 wrangler 中**不會從頂層繼承到 env**，每個 env 都要完整寫一份。
- secrets（不寫進檔案）：`JWT_SECRET`、`PHONE_PEPPER`、`QR_ROOT_SECRET`、`VAPID_PRIVATE_KEY`、`VAPID_PUBLIC_KEY`、`VAPID_SUBJECT`、
  `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`、`CF_ANALYTICS_TOKEN`（用量計量查 GraphQL／AE SQL，唯讀）。
- Cron 以 **UTC** 執行。「每家店依自己時區換日」由每小時那支 cron 判斷「哪些門店的營業日剛結束」來處理。

## 4. 一鍵佈署設計

### 4.1 首次建置 `scripts/bootstrap.sh <staging|production>`（可重複執行）

| 步驟 | 動作 | 冪等判斷 |
|---|---|---|
| 0 | 檢查 `node ≥ 20`、`pnpm`、`wrangler`、`jq`、`openssl`；`wrangler whoami` 已登入；讀 `scripts/config.<env>.env`（網域、管理員 email） | 缺什麼直接中止並說明 |
| 1 | 建 D1 `qcs-db[-staging]` | `wrangler d1 list --json` 已有同名 → 取既有 id |
| 2 | 建 KV `qcs-license[-staging]` | `wrangler kv namespace list` 已有 → 取既有 id |
| 3 | 建 R2 `qcs-media[-staging]` | `wrangler r2 bucket list` 已有 → 跳過 |
| 4 | 建 Queues ×4（history、push、兩個 DLQ） | `wrangler queues list` 已有 → 跳過 |
| 5 | 把 id 寫回 `apps/api/wrangler.toml` 的 `__*_<ENV>__` 佔位 | 佔位已被取代 → 跳過；若已填的 id 與實際不符 → 中止並提示 |
| 6 | 產生並設定 secrets | `wrangler secret list --env <env>` 已有 → **不覆蓋**（覆蓋 JWT／QR 金鑰會讓所有裝置登出、所有 QR 失效） |
|   | `JWT_SECRET`、`PHONE_PEPPER`、`QR_ROOT_SECRET`：`openssl rand -base64 48` | |
|   | `VAPID_*`：Node `crypto.generateKeyPairSync('ec',{namedCurve:'P-256'})` → JWK → base64url；公鑰同時寫進前端環境變數 | |
| 7 | 建 10 個 Pages 專案（5 app × 環境）：`wrangler pages project create qcs-<app>[-staging] --production-branch main` | `wrangler pages project list` 已有 → 跳過 |
| 8 | D1 migration：`wrangler d1 migrations apply qcs-db[-staging] --remote --env <env>` | wrangler 自己記錄已套用的 migration |
| 9 | 首次 `wrangler deploy --env <env>`（建立 Worker、DO class、Queue consumer、Cron、`api.` 自訂網域） | 重複 deploy 無副作用 |
| 10 | 上傳語音素材 `assets/audio/**` → R2 `voice/...`（依 manifest 版本） | 物件已存在且 hash 相同 → 跳過 |
| 11 | 建立預設品牌＋第一位平台管理員：`wrangler d1 execute ... --command "INSERT OR IGNORE ..."` | `INSERT OR IGNORE` |
| 12 | 綁定網域與 Access（見 §6、§7）：有 `CF_API_TOKEN` 具對應權限時以 API 自動做，否則印出 dashboard 操作步驟 | 已存在 → 跳過 |
| 13 | 執行 `scripts/deploy.sh <env>` 完成第一次完整部署 | — |

### 4.2 日常部署 `scripts/deploy.sh <staging|production>`

```
1. pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm test     （失敗即停，什麼都沒動）
2. 記下目前 Worker 版本：wrangler deployments list --env <env> → PREV_VERSION
3. D1 migration：wrangler d1 migrations apply <db> --remote --env <env>   （只允許向下相容的 migration）
4. wrangler deploy --env <env>                 （Worker + DO + Queue consumer + Cron 一次上）
5. 5 個前端：pnpm --filter <app> build → wrangler pages deploy apps/<app>/dist --project-name qcs-<app>[-staging] --branch main
6. scripts/smoke.sh <env>：
   a. GET https://api.<domain>/health → 200 且 {version} 等於本次 commit
   b. WebSocket：以 smoke 測試門店的測試 device token 連 /ws/store/<smokeStoreId>，送 "ping" 須在 5 秒內收到 "pong"，並收到 hello
   c. GET 5 個前端首頁 → 200，且 HTML 內含本次 build 的 asset hash
7. smoke 失敗 → wrangler rollback <PREV_VERSION> --env <env>（只回滾 Worker；D1 不回滾，見 §5）並以非 0 結束
```

- 順序是刻意的：**先 migration 再 Worker**——因為 migration 只做向下相容（加表／加欄），舊 Worker 碰到新 schema 不會壞，
  所以 Worker 回滾永遠安全。
- smoke 門店：bootstrap 建一家 `smoke` 測試門店（不在總後台列表顯示），專供部署驗證。

### 4.3 回滾 `scripts/rollback.sh <env> [version-id]`

| 對象 | 方式 |
|---|---|
| Worker（含 DO 程式碼、Queue consumer、Cron） | `wrangler rollback [version-id] --env <env>`；不帶 id 回到上一版 |
| Pages | Cloudflare dashboard → 專案 → Deployments → 選上一個 → Rollback；或 Pages API 的 rollback 端點（**未查證**端點細節，腳本草稿以 API 實作，實測時確認） |
| D1 | **不回滾 schema**。資料出錯用 D1 Time Travel（30 天）還原到時間點：`wrangler d1 time-travel restore <db> --timestamp <ISO>`（指令細節**未查證**） |
| DO class | 不可回滾刪除／改名；所以 DO 的 schema 變更一律在 DO 內以 `user_version` 向前遷移，程式碼要能讀舊格式 |

### 4.4 GitHub Actions（`.github/workflows/deploy.yml`）

```yaml
on:
  push:
    branches: ["**"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: deploy-${{ github.ref_name == 'main' && 'production' || 'staging' }}
    environment: ${{ github.ref_name == 'main' && 'production' || 'staging' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: bash scripts/deploy.sh ${{ github.ref_name == 'main' && 'production' || 'staging' }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- `main` → production；其他分支 → staging（同一時間只有一個 staging 部署，`concurrency` 排隊）。
- GitHub `production` environment 可設「需人工核准」作為上線閘門。
- bootstrap **不放 CI**（只在首次或新增資源時由人執行）。

### 4.5 API Token 最小權限

**CI 用（`CLOUDFLARE_API_TOKEN`，只做日常部署）**

| 範圍 | 權限 |
|---|---|
| Account | Workers Scripts Write |
| Account | D1 Write |
| Account | Workers KV Storage Write |
| Account | Workers R2 Storage Write |
| Account | Queues Write |
| Account | Cloudflare Pages Write |
| Account | Account Settings Read |
| Zone（只選你的網域） | Workers Routes Write |
| Zone（只選你的網域） | DNS Write（Worker 自訂網域需要建 DNS 紀錄） |

**bootstrap 額外需要**（另開一支短期 token，用完可刪）：Access: Apps and Policies Write（建立總後台 Access 應用）。
**用量計量用**（`CF_ANALYTICS_TOKEN`，存成 Worker secret）：Account Analytics Read（唯讀）。

權限名稱依 2026-10-27 查證之 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)；
dashboard 顯示名稱可能略有不同（例如「Cloudflare Pages」或「Pages」），以畫面為準。

## 5. D1 migration 規則

- 只能：`CREATE TABLE`、`ALTER TABLE ADD COLUMN`（nullable 或有 DEFAULT）、`CREATE INDEX`。
- 禁止：`DROP`、`RENAME`、改欄位型別。要淘汰欄位：先在程式不再讀寫（一個以上版本），之後另案清理。
- 每支 migration 檔名遞增 `NNNN_描述.sql`，進 code review。

## 6. 網域

1. 網域在 Cloudflare 託管（nameserver 指向 Cloudflare）。
2. Worker `api.`：由 `wrangler.toml` 的 `custom_domain = true` 自動建立 DNS 與憑證。
3. Pages 5 個子網域（`admin.` `store.` `staff.` `display.` `q.`）：Pages 專案 → Custom domains → 新增；
   網域在同一帳號時 DNS 由 Cloudflare 自動建立。（wrangler 是否有指令可綁 Pages 自訂網域：**未查證**；腳本以 Pages API 實作）
4. R2 `media.`：R2 bucket → Settings → Custom Domains → 新增（公開唯讀，經 Cloudflare 快取）。

## 7. 總後台 Cloudflare Access

1. Zero Trust dashboard → Access → Applications → Add → Self-hosted。
2. Application domain：`admin.<domain>`，以及 `api.<domain>/admin/*`（API 的平台管理路由）。
3. Policy：Allow → Emails → 平台管理員 email 清單（≤ 50 人免費）。
4. Login method：One-time PIN（email 驗證碼）即可，不必接 IdP。
5. 把 Application 的 **AUD tag** 與 team domain 設為 Worker secret `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`，
   Worker 對 `/admin/*` 驗證 `Cf-Access-Jwt-Assertion`（雙重保險：即使有人繞過 Access 直打 Worker 也會被擋）。

## 8. 監控

| 指標 | 看哪裡 | 正常值／警示 |
|---|---|---|
| **DO Duration（GB-s）** | Dashboard → Workers → Durable Objects → Metrics（或 GraphQL `durableObjectsPeriodicGroups`） | **非營業時間應趨近 0**；夜間有固定斜率＝有 DO 沒 hibernate（查 `setTimeout`、`ws.accept`、外部 fetch） |
| DO requests ÷ 當日號碼數 | 總後台用量頁 | 4～10；> 20 表示輪詢或心跳誤用 |
| Worker 錯誤率 | Workers Observability | > 1% 警示 |
| Queue backlog／DLQ | Queues dashboard | backlog 應趨近 0；DLQ 有訊息即查 |
| D1 大小 | `wrangler d1 info` | > 7 GB 啟動對策（03-data-model §5） |
| 每店異常 | 總後台「用量與成本」警示 | 見 12-usage-metering |

## 9. 資料保留 Cron（`30 19 * * *` UTC）

```
DELETE FROM tickets_history    WHERE ended_at   < now - 90d
DELETE FROM push_subscriptions WHERE created_at < now - 24h
DELETE FROM audit_logs         WHERE at         < now - 365d
DELETE FROM usage_hourly       WHERE hour_start < now - 35d     （見 12-usage-metering）
```

每批以 `LIMIT 5000` 分次刪除，避免單次查詢過久。

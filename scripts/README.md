# scripts/（部署腳本：2026-10-27 已在共用帳號實際部署並實測）

只有 **production** 一個環境（ADR-049：DEMO 用途、成本最低）。網域 `jjoy.ai`，所有雲端資源 `call-` 前綴＋`-production` 後綴。
前端是 5 個 assets-only Worker `call-<sub>-production`（Custom Domain `call-<sub>.jjoy.ai`；不是 Pages，ADR-050）。

| 檔案 | 用途 |
|---|---|
| `config.example.env` | 憑證檔範本 → 複製成 `~/.config/queue-call-system/cf.env`（`chmod 600`，不進 repo） |
| `lib.sh` | 共用函式：載入 cf.env、`call-` 安全閘、資源計畫 `print_plan`、隔離的 wrangler（`cfw`／`wr`）、Cloudflare API（`cf_api`） |
| `lib.test.sh` | `lib.sh` 自我測試（不連網）；`pnpm test` 會跑 |
| `bootstrap.sh [production]` | 首次建置（冪等，**首次部署後再跑一次**以取得 Access team domain）：資源計畫 → D1／KV／R2（CORS、`call-media` 自訂網域）／Queues → 檢查 5 個前端 wrangler.toml → migration → 首次部署 API Worker → secrets（已存在不覆蓋）→ Access 應用 `call-admin`＋policy → smoke 門店與店長（帳密產生到 `~/.config/queue-call-system/smoke.json`）、平台管理員 → `deploy.sh`。`SKIP_DEPLOY=1` 略過最後的 deploy |
| `deploy.sh [production]` | 一鍵部署：typecheck＋`pnpm test`＋`pnpm e2e`（`SKIP_E2E=1` 略過）→ 記下目前版本 → migration → API Worker（`VERSION`＝git sha）→ 同步 Access 名單 → 建置並 `wrangler deploy` 5 個前端 Worker → smoke →（失敗）自動回滾 API Worker |
| `smoke.sh [production]` | 部署後在正式網址驗證（不讀 cf.env）：health 版本、WebSocket、5 個前端、admin `/api/*` 未登入被擋、API 網域總後台路由 401、media CORS |
| `smoke-ws.mjs <api>` | smoke 的 WebSocket 檢查：以 smoke 店長登入 → 連 `store_smoke` → 收到 hello、`ping`→`pong`（讀 `smoke.json`，權限須 600） |
| `rollback.sh [production] [version-id] [--frontends]` | 回滾 API Worker（不帶 id＝上一版）；`--frontends` 再把 5 個前端 Worker 各回到上一版。**不要回滾到 bootstrap 的第一個版本**（早於 secrets，08 §4.2） |

Demo 資料：`pnpm seed:demo [--env production --confirm] [--reset] [--skip-media]`（`apps/api/scripts/seed-demo.mjs`，見 `docs/13-demo-seed.md`）；
正式網址 E2E：`pnpm e2e:prod`（`docs/11-local-testing.md` §4.1）。

## 共用帳號的安全規則

- **憑證只讀** `~/.config/queue-call-system/cf.env`（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ZONE_ID`、`ACCESS_ALLOWED_EMAILS`）。
  腳本不印出、不記錄任何值；請勿 `cat` 這個檔，也不要在腳本加 `set -x`。
- **不用全域 `wrangler login`**：wrangler 一律經 `cfw()` 執行——`HOME`／`XDG_CONFIG_HOME` 指向每次執行的暫存目錄，
  token 以環境變數帶入（不經命令列）。依 wrangler 4.153 原始碼：環境變數 token 優先於已存的 OAuth 登入，
  全域設定目錄由 `HOME`（舊版 `~/.wrangler`）或 `XDG_CONFIG_HOME` 決定；`CLOUDFLARE_API_KEY`＋`CLOUDFLARE_EMAIL` 會優先於 token，所以 `cfw()` 先清掉。
  其他 wrangler 版本是否相同：**未查證**（repo 鎖定版本，`require_tools` 優先用 `apps/api/node_modules/.bin/wrangler`）。
- **安全閘**：會建立或修改的每個資源名稱都先過 `assert_call_name`（必須 `call-` 開頭）、網域過 `assert_call_host`（只允許 `call-*.jjoy.ai`）、
  wrangler.toml 的 `[env.production]` 由 `check_toml_names` 整段檢查；`cf_api` 只允許本帳號／本 zone 的路徑。不符一律非 0 結束。
- 既有、指向別處的 DNS 紀錄與同名但網域不同的 Access 應用一律**不修改**，只提示人工確認。
- 不碰 zone 層級的 Cache Rules（整個 ruleset 以 PUT 覆寫會清掉同 zone 其他產品的規則），改為文件手動步驟（docs/08 §6.1）。

設計見 `docs/08-deploy-and-ops.md` §4；業主操作見 `docs/10-deploy-guide-for-owner.md`。
`gen-audio.*` 由語音素材另案維護。

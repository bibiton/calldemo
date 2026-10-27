# scripts/（部署腳本：草稿，尚未對 Cloudflare 實測）

只有 **production** 一個環境（ADR-049：DEMO 用途、成本最低）。網域 `jjoy.ai`，所有雲端資源 `call-` 前綴＋`-production` 後綴。

| 檔案 | 用途 |
|---|---|
| `config.example.env` | 憑證檔範本 → 複製成 `~/.config/queue-call-system/cf.env`（`chmod 600`，不進 repo） |
| `lib.sh` | 共用函式：載入 cf.env、`call-` 安全閘、隔離的 wrangler（`cfw`／`wr`）、Cloudflare API（`cf_api`） |
| `lib.test.sh` | `lib.sh` 自我測試（不連網）；`pnpm test` 會跑 |
| `bootstrap.sh [production]` | 首次建置（冪等）：D1／KV／R2（CORS、`call-media` 自訂網域）／Queues／Pages／secrets／Pages 網域／Access |
| `deploy.sh [production]` | 一鍵部署：typecheck＋`pnpm test`＋`pnpm e2e` → migration → Worker → 5 個 Pages → smoke →（失敗）回滾 Worker |
| `smoke.sh [production]` | 部署後在正式網址驗證（`smoke-ws.mjs` 尚未撰寫，缺檔時略過 WS 檢查） |
| `rollback.sh [production] [version]` | 回滾 Worker |

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

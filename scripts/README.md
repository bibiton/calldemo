# scripts/（草稿，未實測）

| 檔案 | 用途 |
|---|---|
| `config.example.env` | 環境設定範本 → 複製成 `config.<env>.env` |
| `lib.sh` | 共用函式 |
| `bootstrap.sh <env>` | 首次建置（冪等） |
| `deploy.sh <env>` | 日常部署＋smoke＋失敗回滾 |
| `smoke.sh <env>` | 部署後驗證（`smoke-ws.mjs` 尚未撰寫） |
| `rollback.sh <env> [version]` | 回滾 Worker |

設計見 `docs/08-deploy-and-ops.md` §4；實作與實測見 `docs/09-roadmap.md` M6。
`gen-audio.*` 由語音素材另案維護。

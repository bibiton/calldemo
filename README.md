# 叫號系統（queue-call-system）— 規劃文件

> 狀態：**M0～M5 已實作；M6（一鍵部署）與 M7（Demo 資料包）完成並已部署到正式 DEMO 環境 `*.jjoy.ai`**（2026-10-27）。
> 本機：Vitest 324、node:test 8、lib.test 48、Playwright 43；正式網址：smoke 全過、`pnpm e2e:prod` 5 項全過、回滾實測通過。
> 仍需實機：手機掃 QR、電視聲音、iPhone 推播、夜間 DO Duration（見 [docs/09-roadmap.md](docs/09-roadmap.md) M6／M7 實作狀態）。
> 文件日期：2026-10-27。價格查證日期：2026-10-27（來源見 [docs/02-cost-model.md](docs/02-cost-model.md)）。

## 一句話

全部跑在 Cloudflare 上的多門店叫號 SaaS：顧客在**店內叫號面板上掃動態 QR** → 填姓名＋手機取號 →
用 Web（WebSocket＋Web Push）收通知；櫃台人員用手機叫號；面板顯示叫號、語音播報、輪播廣告。

## 最高原則

1. **成本最低為主**
2. **不能犧牲使用者體驗**（UX 是底線）——省錢但會讓顧客／店員／面板體驗變差的選項一律不選

判準與檢查表見 [docs/00-principles.md](docs/00-principles.md)。

## 架構速覽

```
顧客手機 ─┐                                   ┌─ D1（主檔＋歷史）
人員手機 ─┼─ 5 個 SPA（assets-only Worker，靜態免費，ADR-050）├─ KV（門店開通狀態快取）
面板電視 ─┤                                   ├─ R2（Logo／廣告）
後台     ─┘── Worker API（Hono）──────────────┼─ Queues（歷史批次寫入、Web Push）
                 │                             └─ Cron（每日彙總、清理）
                 └─ StoreQueueDO（每店一個，SQLite＋Hibernatable WebSocket）
```

## 成本估算（月，USD，Workers Paid）

| 規模 | 估算 | 每店每月 |
|---|---|---|
| 50 店 | **約 $5.6** | $0.11 |
| 200 店 | **約 $10.5** | $0.05 |
| 500 店 | **約 $32.4** | $0.06 |

假設與明細見 [docs/02-cost-model.md](docs/02-cost-model.md)。只要 WebSocket 不用 Hibernation API，
50 店就會多出約 **$197／月**，500 店多出約 **$2,000／月**——這是全案最大的成本風險。

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/00-principles.md](docs/00-principles.md) | 成本優先、UX 底線的判準與檢查表 |
| [docs/01-architecture.md](docs/01-architecture.md) | 架構圖、各 Cloudflare 服務分工、請求流程 |
| [docs/02-cost-model.md](docs/02-cost-model.md) | 已查證單價、50/200/500 店估算、讓成本爆掉的寫法 |
| [docs/03-data-model.md](docs/03-data-model.md) | D1 完整 SQL、DO SQLite schema、個資保存規則 |
| [docs/04-realtime-protocol.md](docs/04-realtime-protocol.md) | WebSocket 訊息格式、seq／補推、hibernation 規範、心跳、動態 QR |
| [docs/05-apps.md](docs/05-apps.md) | 5 個前端頁面清單、手機直版線框、MVP 與後續 |
| [docs/06-auth-and-licensing.md](docs/06-auth-and-licensing.md) | 身分、門店開通／停用／到期、面板配對、取號 token、稽核 |
| [docs/07-notifications.md](docs/07-notifications.md) | WS＋Web Push、iOS 限制與 UX 對策、語音 |
| [docs/08-deploy-and-ops.md](docs/08-deploy-and-ops.md) | monorepo、wrangler.toml、一鍵佈署設計、CI、回滾、監控 |
| [docs/09-roadmap.md](docs/09-roadmap.md) | 分階段任務、完成條件與驗證方式 |
| [docs/10-deploy-guide-for-owner.md](docs/10-deploy-guide-for-owner.md) | 給業主的逐步佈署教學（非工程師版） |
| [docs/11-local-testing.md](docs/11-local-testing.md) | 本機開發（wrangler dev 一鍵起全部）、Vitest 必測情境、Playwright E2E、部署後正式網址實機驗證 |
| [docs/12-usage-metering.md](docs/12-usage-metering.md) | 每店用量計量、成本分攤、總後台用量頁與異常警示 |
| [docs/13-demo-seed.md](docs/13-demo-seed.md) | Demo 資料包（虛構迴轉壽司品牌、素材授權、模擬叫號、一鍵灌入） |
| [DECISIONS.md](DECISIONS.md) | 決策紀錄（ADR） |
| [scripts/](scripts/) | bootstrap／deploy／rollback／smoke 腳本（M6 已實測） |
| `assets/audio/` | 預錄叫號語音素材與 `manifest.json`（另案產生；建置時複製進 `apps/display` 隨前端部署，ADR-026） |
| `assets/demo/` | Demo 品牌「鮮迴壽司」素材（廣告圖、影片、Logo）與來源授權 `CREDITS.md`（M7） |

## Monorepo 規劃

```
apps/
  admin/      總後台（平台方，Cloudflare Access 保護）
  store/      門店後台
  staff/      場內人員端（櫃台叫號）
  display/    叫號面板（店內直立電視）
  customer/   顧客取號頁（掃面板 QR 進入）
  api/        Worker（Hono）＋ StoreQueueDO ＋ Queue consumer ＋ Cron
packages/
  shared/     型別、WS 協定、驗證（手機格式、姓名遮罩）、QR token 演算法
assets/audio/ 預錄語音素材＋manifest.json（另案產生）
scripts/      bootstrap.sh / deploy.sh / rollback.sh / smoke.sh / smoke-ws.mjs
```

前端一律 React + Vite + Tailwind，**手機直版優先**（mobile-first、portrait）。不用 Next.js。

## 本機開發

```bash
pnpm install
node apps/api/scripts/seed-local.mjs   # 套用 D1 migration＋灌示範資料，印出面板／人員端網址與 PIN
pnpm dev      # API 8787、admin 5171、store 5172、staff 5173、display 5174、customer 5175
              # 門店後台：http://localhost:5172/  demo-demo01@example.com ／ demo-password（seed 會印出各店帳號）
pnpm test     # T12 靜態檢查＋全部 Vitest（api／display／shared）
pnpm e2e      # Playwright：獨立環境（8788／617x），截圖輸出 test-results/visual/
pnpm seed:demo   # Demo 品牌「鮮迴壽司」3 家門店（本機；輸出 apps/api/.wrangler/demo-output.json）
```

顧客取號網址由面板上的 QR 產生（面板頁 `data-qr-url` 屬性也有同一網址）。

## 部署（只有 production，ADR-049）

DEMO 用途、成本最低：只有一個正式環境，網域 `jjoy.ai`（共用 Cloudflare 帳號，本系統資源一律 `call-` 前綴，腳本有安全閘）。

```
本機 pnpm test ＋ pnpm e2e 全過
  → bash scripts/deploy.sh          # 一鍵部署（憑證只讀 ~/.config/queue-call-system/cf.env），smoke 失敗自動回滾 API Worker
  → pnpm e2e:prod                   # （選用）正式網址 E2E，截圖 test-results/production/
  → 手機／電視實機驗證（docs/10 C 段）
```

首次建置 `bash scripts/bootstrap.sh`，逐步說明見 [docs/10-deploy-guide-for-owner.md](docs/10-deploy-guide-for-owner.md)，設計見 [docs/08-deploy-and-ops.md](docs/08-deploy-and-ops.md)。

## DEMO 網址與登入方式

| 網址 | 用途 | 登入 |
|---|---|---|
| `https://call-display.jjoy.ai` | 叫號面板（電視直立 1080×1920） | 配對碼，或 demo 輸出檔裡已配對的面板網址（`?token=…`） |
| `https://call-q.jjoy.ai` | 顧客取號 | 不用登入：手機掃面板上的 QR |
| `https://call-staff.jjoy.ai` | 人員端（櫃台叫號） | 已配對手機網址（`?device=…`）→ 選人員 → 6 位 PIN |
| `https://call-store.jjoy.ai` | 門店後台 | 店長 email＋密碼 |
| `https://call-admin.jjoy.ai` | 總後台 | Cloudflare Access：輸入名單內 email → 收 6 位數驗證碼（One-time PIN） |
| `https://call-api.jjoy.ai` | API（`/health` 可看版本） | — |
| `https://call-media.jjoy.ai` | 廣告／Logo（R2，不開 r2.dev） | 公開唯讀 |

Demo 門店（虛構品牌「鮮迴壽司」，`pnpm seed:demo --env production --confirm` 建立；服務 A 內用／B 外帶；營業 10:00–22:00）：

| 門店 | 門店碼 | 店長帳號 | 櫃台 | 模擬叫號 |
|---|---|---|---|---|
| 鮮迴壽司 台北中山店 | `DEMOSK01` | `senkai-zs@example.com` | 1、2 內用／3 外帶 | **開**（營業時間內、有面板連線時每 20 秒自動取號叫號，總後台「模擬叫號」可關） |
| 鮮迴壽司 台中公益店 | `DEMOSK02` | `senkai-gy@example.com` | 1 內用／2 外帶 | 關 |
| 鮮迴壽司 高雄左營店 | `DEMOSK03` | `senkai-zy@example.com` | 1 內用／2 外帶 | 關 |

- **店長密碼、人員 PIN、已配對面板／人員手機網址**：在部署者電腦的 `~/.config/queue-call-system/demo-output.json`（權限 600，**不進 repo**；重跑 seed 會沿用同一組）。
- 總後台名單＝cf.env 的 `ACCESS_ALLOWED_EMAILS`；改名單後跑 `bash scripts/bootstrap.sh`。
- 畫面角落固定顯示「DEMO・虛構品牌」；素材來源與授權見 [assets/demo/CREDITS.md](assets/demo/CREDITS.md)。

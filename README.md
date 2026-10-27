# 叫號系統（queue-call-system）— 規劃文件

> 狀態：**規劃階段，尚無程式碼**。`scripts/` 底下只有腳本草稿，**未實測**。
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
人員手機 ─┼─ Pages（5 個 SPA，靜態免費）       ├─ KV（門店開通狀態快取）
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
| [docs/11-local-testing.md](docs/11-local-testing.md) | 本機開發（wrangler dev 一鍵起全部）、Vitest 必測情境、Playwright E2E、staging 實機驗證 |
| [docs/12-usage-metering.md](docs/12-usage-metering.md) | 每店用量計量、成本分攤、總後台用量頁與異常警示 |
| [docs/13-demo-seed.md](docs/13-demo-seed.md) | Demo 資料包（虛構迴轉壽司品牌、素材授權、模擬叫號、一鍵灌入） |
| [DECISIONS.md](DECISIONS.md) | 決策紀錄（ADR） |
| [scripts/](scripts/) | bootstrap／deploy／rollback 腳本草稿（**未實測**） |
| `assets/audio/` | 預錄叫號語音素材與 `manifest.json`（另案產生；建置時複製進 `apps/display` 隨 Pages 部署，ADR-026） |

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
scripts/      bootstrap.sh / deploy.sh / rollback.sh / smoke.sh（草稿）
```

前端一律 React + Vite + Tailwind，**手機直版優先**（mobile-first、portrait）。不用 Next.js。

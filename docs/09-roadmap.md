# 09 — Roadmap

不寫天數 ETA；每項有**完成條件**與**驗證方式**。前一階段的驗證全過才進下一階段。

## M0 — 技術驗證（先拆掉最大的未知）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 0.1 | 最小 DO：`acceptWebSocket`＋auto-response `ping/pong`＋一個 alarm | 部署到 staging，連 5 條 WS 過夜 | 隔天 DO Duration 夜間為平線；`ping` 有 `pong` |
| 0.2 | 本機 workerd 對 hibernation、auto-response、alarm 的支援 | 寫成測試 | `pnpm test` 通過；不支援的部分寫進 11-local-testing |
| 0.3 | PBKDF2 iteration 上限 | 實測 100,000 與更高值 | 結果寫回 06-auth |
| 0.4 | Web Push（VAPID＋aes128gcm）純 WebCrypto | Android Chrome、iOS 主畫面 app 各收到一則 | 實機截圖 |
| 0.5 | GraphQL introspection：DO 資料集是否有 `objectId`、`activeTime` | 結果寫回 12-usage-metering §5 | 查詢結果存檔 |
| 0.6 | 面板 QR 掃描距離 | 55 吋直立電視、QR 邊長 38% 寬 | 2 公尺、2.5 公尺、3 公尺各 3 支手機（含 iPhone、低階 Android）可掃 |

## M1 — 核心叫號（單店可用）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 1.1 | monorepo 骨架（pnpm、5 app、api、shared、lint 規則 T12） | `pnpm dev` 起全部 | 本機 6 個 port 皆可開 |
| 1.2 | D1 migration 0001＋seed | 本機與 staging 套用成功 | `wrangler d1 migrations list` |
| 1.3 | StoreQueueDO：取號、狀態機、seq／events、cmd 冪等、營業日歸零、關店 alarm | T1、T2、T5、T6、T11 | Vitest 全過 |
| 1.4 | Worker：身分驗證、license 檢查、WS upgrade 轉交 | T3、T4 | Vitest |
| 1.5 | 動態 QR（面板端計算、Worker 驗證、取號 session） | T7、T8 | Vitest＋實機掃描 |
| 1.6 | 顧客頁：選服務、姓名手機、個資同意、防重複、號碼頁 | T9、T10 | Playwright 手機直版 |
| 1.7 | 人員端：PIN 登入、叫號全部指令、遮罩／按住顯示 | 指令皆有 ack | Playwright |
| 1.8 | 面板：版面、QR 區、叫號大字、近期叫號、斷線提示 | 1080×1920 截圖符合 05-apps | Playwright 截圖比對 |
| 1.9 | 叫號播放：叮咚→預錄句型（依 `assets/audio/manifest.json`）→趣味穿插，播放佇列，音訊解鎖提示 | T14、T16、T17 | Vitest＋實機聽 |
| 1.10 | E2E 主流程 | 掃碼取號→叫號→面板顯示 | Playwright 通過 |

## M2 — 通知

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 2.1 | 前景 WS 提醒（全螢幕、響鈴、震動） | 叫號 1 秒內出現 | 實機 |
| 2.2 | 背景 Web Push（q-push consumer、訂閱生命週期） | 404/410 刪訂閱、429 重試 | Vitest（`createMessageBatch`）＋實機 |
| 2.3 | iOS 加入主畫面教學＋轉交碼 | iOS 16.4+ 主畫面 app 收到推播 | 實機 iPhone |

## M3 — 門店後台與授權

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 3.1 | 店長登入、服務類別、櫃台、人員、營業時間 | CRUD 完成、稽核寫入 | Playwright |
| 3.2 | 面板／人員裝置配對與解除 | 超過 `max_devices` 被拒；解除後該裝置斷線 | Vitest＋Playwright |
| 3.3 | 叫號聲音設定（音量、次數、叮咚、趣味頻率、靜音時段） | 改設定後面板即時套用 | 實機 |
| 3.4 | 廣告管理：上傳、排序、秒數、時段、容量條 | 超過大小／容量被擋；manifest 版本推送 | Playwright＋實機 |
| 3.5 | 面板廣告播放：Service Worker 快取、版本更新、斷網續播、叫號讓位 | T15；拔網路線後持續播放 | 實機 |
| 3.6 | 報表（daily_stats、CSV） | 數字與 tickets_history 一致 | Vitest |

## M4 — 總後台與計量

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 4.1 | Access 保護＋JWT 驗證 | 未授權 email 進不去；直打 API 401 | 實測 |
| 4.2 | 門店開通／停用／到期／上限／功能開關／廣告容量上限 | 停用後 60 秒內全面 403、WS 立即斷 | T3＋staging 實測 |
| 4.3 | 用量計量：AE 寫入、DO 計數併入 state、usage_hourly／daily／monthly | T18；與 Cloudflare 帳號層級數字誤差 < 20% | staging 跑一週比對 |
| 4.4 | 用量與成本頁、帳單分攤、排行、異常警示、CSV | 人為製造夜間喚醒時出現警示 | staging |

## M5 — 上線前

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 5.1 | 壓測（k6） | 單店 5 分鐘 300 號＋50 面板同時連線；p95 叫號延遲 < 1 秒 | k6 報告 |
| 5.2 | 個資檢查 | D1 無姓名／手機原文；關店後 DO 原文清空 | T13＋staging 抽查 |
| 5.3 | 安全檢查 | 無硬編碼密鑰、輸入驗證、CORS 白名單、稽核 | security review |
| 5.4 | 夜間成本 | staging 連續 3 晚 DO Duration 夜間平線 | dashboard 截圖 |

## M6 — 一鍵佈署腳本實作與實測

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 6.1 | `bootstrap.sh` | 在**全新 Cloudflare 帳號**從零跑完；再跑第二次全部顯示「已存在，略過」且 secrets 未被覆蓋 | 兩次執行紀錄 |
| 6.2 | `deploy.sh`＋`smoke.sh` | 正常部署通過；故意部署壞版本時自動 rollback 且服務不中斷 | staging 演練紀錄 |
| 6.3 | `rollback.sh` | Worker 回到指定版本；Pages 回滾步驟實測並修正文件 | 演練紀錄 |
| 6.4 | GitHub Actions | 非 main → staging、main → production（人工核准） | Actions 紀錄 |
| 6.5 | 業主教學實測 | 由非工程師依 10-deploy-guide 獨立完成 staging 佈署 | 過程中卡住的點全部回寫文件 |

## M7 — Demo 資料包（見 13-demo-seed）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 7.1 | 虛構品牌視覺（名稱商標檢索、SVG Logo、配色） | 無同名註冊商標衝突 | 檢索結果存檔 |
| 7.2 | 蒐集 5～8 張廣告圖＋1～2 支直式短影片 | 全部符合規格；`demo/assets/SOURCES.md` 每張有來源 URL 與授權 | 人工逐張審核：無真實品牌元素、無可辨識人臉 |
| 7.3 | `seed:demo` 腳本（本機／staging，`--reset`） | 重跑冪等；拒絕 production | 本機與 staging 各跑兩次 |
| 7.4 | `demo:simulate` 腳本 | 面板連續 30 分鐘自動叫號，語音、廣告讓位正常 | staging 實機錄影 |

## M8 — 叫號機 Android 包裝 App＋硬體建議清單（ADR-027）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 8.1 | `apps/display-android`（WebView、免手勢播放、HOME launcher、immersive、常亮、斷網重連、網址白名單、JS bridge） | **冷開機到第一次叫號出聲，全程不需觸碰** | 3 款裝置各做 5 次：斷電 → 通電 → 遠端叫號 → 聽到叮咚與語音 |
| 8.2 | 斷電／斷網恢復 | 斷網 10 分鐘後恢復，面板自動重連並能出聲；斷電後來電自動開機進 App | 實機 |
| 8.3 | 音訊被擋回報 | 在一般瀏覽器開面板不點擊 → 門店後台與總後台 1 分鐘內出現「無法出聲」警示；點擊後警示消失 | staging 實測 |
| 8.4 | 替代方案驗證：Fully Kiosk Browser、Chromium kiosk＋`--autoplay-policy` | 各自冷開機免觸碰出聲（或記錄失敗原因） | 實機紀錄回寫 05-apps |
| 8.5 | 硬體建議清單 | 至少 1 款電視盒、1 款平板、1 款迷你電腦通過 8.1～8.2，連續 7 天 12 小時播放廣告＋叫號無當機 | 實測報告（型號、價格、Android 版本、RAM、溫度） |

硬體初步建議（待 8.5 驗證）：Android 9 以上且 WebView 可經 Play 商店更新、RAM ≥ 2 GB（建議 4 GB）、
支援 1080p H.264 硬體解碼、有線網路優先、HDMI 輸出（聲音走電視喇叭或外接喇叭）、**斷電來電自動開機**（電視盒需確認；迷你電腦需 BIOS「AC Power On」）。

## 後續（不在 MVP）

多品牌 UI、台語／英語語音、預約取號、回訪統計、報表 NDJSON 匯出 R2、方案分級收費自動化（ADR-020）。

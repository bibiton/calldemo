# 09 — Roadmap

不寫天數 ETA；每項有**完成條件**與**驗證方式**。前一階段的驗證全過才進下一階段。

## M0 — 技術驗證（先拆掉最大的未知）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 0.1 | 最小 DO：`acceptWebSocket`＋auto-response `ping/pong`＋一個 alarm | 部署到 正式環境，連 5 條 WS 過夜 | 隔天 DO Duration 夜間為平線；`ping` 有 `pong` |
| 0.2 | 本機 workerd 對 hibernation、auto-response、alarm 的支援 | 寫成測試 | `pnpm test` 通過；不支援的部分寫進 11-local-testing |
| 0.3 | PBKDF2 iteration 上限 | 實測 100,000 與更高值 | 結果寫回 06-auth |
| 0.4 | Web Push（VAPID＋aes128gcm）純 WebCrypto | Android Chrome、iOS 主畫面 app 各收到一則 | 實機截圖 |
| 0.5 | GraphQL introspection：DO 資料集是否有 `objectId`、`activeTime` | 結果寫回 12-usage-metering §5 | 查詢結果存檔 |
| 0.6 | 面板 QR 掃描距離 | 55 吋直立電視、QR 邊長 38% 寬 | 2 公尺、2.5 公尺、3 公尺各 3 支手機（含 iPhone、低階 Android）可掃 |

## M1 — 核心叫號（單店可用）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 1.1 | monorepo 骨架（pnpm、5 app、api、shared、lint 規則 T12） | `pnpm dev` 起全部 | 本機 6 個 port 皆可開 |
| 1.2 | D1 migration 0001＋seed | 本機與 正式環境 套用成功 | `wrangler d1 migrations list` |
| 1.3 | StoreQueueDO：取號、狀態機、seq／events、cmd 冪等、營業日歸零、關店 alarm | T1、T2、T5、T6、T11 | Vitest 全過 |
| 1.4 | Worker：身分驗證、license 檢查、WS upgrade 轉交 | T3、T4 | Vitest |
| 1.5 | 動態 QR（面板端計算、Worker 驗證、取號 session） | T7、T8 | Vitest＋實機掃描 |
| 1.6 | 顧客頁：選服務、姓名手機、個資同意、防重複、號碼頁 | T9、T10 | Playwright 手機直版 |
| 1.7 | 人員端：PIN 登入、叫號全部指令、遮罩／按住顯示 | 指令皆有 ack | Playwright |
| 1.8 | 面板：版面、QR 區、叫號大字、近期叫號、斷線提示 | 1080×1920 截圖符合 05-apps | Playwright 截圖比對 |
| 1.9 | 叫號播放：叮咚→預錄句型（依 `assets/audio/manifest.json`），播放佇列，音訊解鎖提示（趣味穿插已取消，ADR-033） | T14、T16、T17 | Vitest＋實機聽 |
| 1.10 | E2E 主流程 | 掃碼取號→叫號→面板顯示 | Playwright 通過 |

### M0／M1 實作狀態（2026-10-27）

✅＝完成條件已在本機達成並有測試；⏳＝本機部分完成、剩餘須部署後在正式環境／實機驗證（ADR-049：只有一套正式環境，沒有 正式環境）；❌＝未做。數字見 `docs/visual-review-M1.md` 與 `pnpm test`／`pnpm e2e`。

| # | 狀態 | 說明 |
|---|---|---|
| 0.1 | ⏳ | 最小 DO＝`StoreQueueDO`（acceptWebSocket、auto-response、關店 alarm）已寫且本機測試通過；**2026-10-27 已部署到正式環境**（smoke 以 `smoke-ws.mjs` 驗證 hello＋`ping`→`pong`）。**連 WS 過夜看 Duration 夜間平線尚未做** |
| 0.2 | ✅ | `apps/api/test/m0-runtime.test.ts`；結果寫入 11-local-testing §1 |
| 0.3 | ⏳ | 本機 workerd 實測 100,000／100,001／600,000 皆可用（不限制）；production 上限待 正式環境；結果寫入 06-auth |
| 0.4 | ⏳ | VAPID（ES256）＋aes128gcm 已以純 WebCrypto 實作（M2），RFC 8291 附錄 A 測試向量逐位元通過、E2E 經本機假推播端點解密驗證；**Android／iPhone 實機收推播未做**（需 正式環境 HTTPS） |
| 0.5 | ❌ | 需 Cloudflare 帳號 API token 做 GraphQL introspection；本階段不使用真實帳號 |
| 0.6 | ⏳ | 1080×1920 版面量測 QR 本體＝39% 螢幕寬（E2E 斷言 ≥ 38%）；2～3 公尺實機掃描未做 |
| 1.1 | ✅ | pnpm monorepo（api／admin／store／staff／display／customer＋shared）；`pnpm dev` 起 8787＋5171～5175 六個 port 實測可開；T12 靜態檢查腳本＋CI workflow |
| 1.2 | ⏳ | `migrations/0001_init.sql`＋`apps/api/scripts/seed-local.mjs`；本機 `wrangler d1 migrations list` 顯示已套用；正式環境 2026-10-27 由 bootstrap／deploy 套用（`wrangler d1 migrations apply --remote`） |
| 1.3 | ✅ | T1、T2、T5、T6、T11 及狀態機全部指令測試通過 |
| 1.4 | ✅ | T3、T4、裝置／人員／顧客 token、WS upgrade 轉交；平台管理 API 只有本機繞過（Access JWT 驗證屬 M4 4.1） |
| 1.5 | ⏳ | T7、T8 Vitest 通過；手機實機掃描未做 |
| 1.6 | ✅ | T9、T10＋Playwright 手機直版（390×844、360×640）通過 |
| 1.7 | ✅ | PIN 登入（連錯 5 次鎖定）、全部指令有 ack（含重連以同 cmdId 重送）、遮罩＋按住顯示完整手機（寫稽核） |
| 1.8 | ✅ | 1080×1920 截圖逐張人工檢查＋量測斷言（QR 比例／不重疊／最上層、大字 ≥ 240px、無溢出）；**未做像素基準比對**（版面仍在變動，先以量測斷言代替） |
| 1.9 | ⏳ | T14、T16、T16b、T16c、T17 通過；E2E 驗證叮咚→前綴→號碼→櫃台 ×2 與佇列不重疊；**實機聽未做**；Service Worker 只做 cache-first，07 §7 分級漸進預載待 M3 3.5；趣味穿插已取消（ADR-033） |
| 1.10 | ✅ | `pnpm e2e` 9 個情境全過（主流程、連叫 3 號、人員操作、顧客錯誤情境、360×640、面板量測、停用、web／app 音訊模式） |

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
| 3.3 | 叫號聲音設定（音量、次數、叮咚、俏皮前綴風格／機率／主題包、靜音時段；趣味穿插已取消，ADR-033） | 改設定後面板即時套用 | 實機 |
| 3.4 | 廣告管理：上傳、排序、秒數、時段、容量條 | 超過大小／容量被擋；manifest 版本推送 | Playwright＋實機 |
| 3.5 | 面板廣告播放：Service Worker 快取、版本更新、斷網續播、叫號讓位 | T15；拔網路線後持續播放 | 實機 |
| 3.6 | 報表（daily_stats、CSV） | 數字與 tickets_history 一致 | Vitest |

### M2／M3 實作狀態（2026-10-27）

測試數：Vitest **210**（api 130、display 39、shared 35、T12 腳本 6；M1 時 146）＋ Playwright **32**（M1 時 9）。視覺紀錄見 [visual-review-M3.md](visual-review-M3.md)。

| # | 狀態 | 說明 |
|---|---|---|
| 2.1 | ⏳ | 顧客頁前景 WS：全螢幕紅底提醒＋響鈴（Web Audio）＋`navigator.vibrate`；重叫再跳一次。E2E 量測人員按重叫 → 顧客頁提醒 **< 1 秒**（本機）。`visibilitychange` 隱藏即關 WS 交給推播。**實機（Android 震動、iPhone 聲音與畫面）未做** |
| 2.2 | ⏳ | `push_subscriptions` 訂閱 API、DO 推播觸發（叫號／重叫／過號／前面剩 N 位，ADR-035）、q-push consumer：404／410 刪訂閱、429 依 Retry-After／5xx 指數退避重試、3 次後放棄、一批 25 則並行（Vitest `createMessageBatch`）；號碼結束由 q-history 刪訂閱、孤兒 24h Cron。E2E：DO → Queue → consumer → **本機假 push service**，Node 端解密 payload＋驗 VAPID 簽章；Service Worker 收推播顯示通知（CDP `deliverPushMessage`）。**真實 FCM／APNs 實機未做** |
| 2.3 | ⏳ | iOS Safari 號碼頁：加入主畫面教學＋6 位轉交碼（ADR-034）；主畫面 app `/resume` 輸入轉交碼取回號碼並可開啟背景提醒；PWA manifest（standalone、start_url `/resume`）。E2E 以 Chromium 模擬 iPhone UA 與 standalone。**iOS 16.4+ 實機推播未做** |
| 3.1 | ✅ | 店長登入（PBKDF2、access 15 分＋HttpOnly refresh cookie 14 天、連錯 5 次鎖 15 分）、服務類別（含每日上限）、櫃台、人員（6 位 PIN 只顯示一次、重設、停用、`max_staff`）、營業時間；每筆寫入同 batch 寫稽核。Vitest＋Playwright |
| 3.2 | ✅ | 面板／人員手機配對（ADR-036）：超過 `max_devices` → 409；解除配對 → 該裝置 WS 立即 4001、token 401、畫面回配對（ADR-037）。Vitest＋Playwright |
| 3.3 | ⏳ | 語音設定頁（風格、前綴機率、餐飲業、主題包／單句、叮咚、次數、音量、靜音時段、手機試聽）；**趣味穿插已移除**（ADR-033）。E2E：儲存後面板下一次叫號即用新叮咚、「來賓」、唸 1 次（settings.changed → 重連取新 hello，ADR-038）。**實機聽未做** |
| 3.4 | ⏳ | 上傳 R2（串流＋伺服器端 SHA-256 驗證、內容定址 key）、前端檢查格式／大小／長度、3:2 只提示（ADR-028）、容量條與 409 QUOTA_EXCEEDED、秒數／時段／星期／日期、啟停、排序（ADR-040）、刪除釋放容量；版本 +1 → DO 廣播 `ads.manifest`。Vitest＋Playwright（51 MB 影片、6 MB 圖片前端擋下）。**實機與 R2 自訂網域（CORS、快取）待 正式環境** |
| 3.5 | ⏳ | T15（M1）；面板收到 `ads.manifest` 重抓清單並請 Service Worker 刪除不再使用的素材；語音包漸進快取 `AudioWarmer`（並行 4、叫號時暫停、順序依 07 §7，單元測試）。**拔網路線續播需實機**；production 的 media 網域為跨來源，SW 快取需 R2 自訂網域開 CORS（正式環境 驗證） |
| 3.6 | ✅ | `daily_stats` 每日 03 點結算＋查詢補算（ADR-039）；Vitest 逐欄比對 tickets_history（取號、各終態、平均／P90 等候、平均服務、尖峰時段）；今日數字由 DO 即時計算；CSV（BOM）E2E 驗證總數與畫面一致 |
| 4.2（部分） | ⏳ | 門店停用／到期：門店後台 API 403 `STORE_SUSPENDED`／`STORE_EXPIRED`、後台顯示「服務已暫停」（Vitest＋Playwright）；平台端操作介面屬 M4 |

## M4 — 總後台與計量

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 4.1 | Access 保護＋JWT 驗證 | 未授權 email 進不去；直打 API 401 | 實測 |
| 4.2 | 門店開通／停用／到期／上限／功能開關／廣告容量上限 | 停用後 60 秒內全面 403、WS 立即斷 | T3＋正式環境 實測 |
| 4.3 | 用量計量：AE 寫入、DO 計數併入 state、usage_hourly／daily／monthly | T18；與 Cloudflare 帳號層級數字誤差 < 20% | 正式環境 跑一週比對 |
| 4.4 | 用量與成本頁、帳單分攤、排行、異常警示、CSV | 人為製造夜間喚醒時出現警示 | 正式環境 |

## M5 — 上線前

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 5.1 | 壓測（k6） | 單店 5 分鐘 300 號＋50 面板同時連線；p95 叫號延遲 < 1 秒 | k6 報告 |
| 5.2 | 個資檢查 | D1 無姓名／手機原文；關店後 DO 原文清空 | T13＋正式環境 抽查 |
| 5.3 | 安全檢查 | 無硬編碼密鑰、輸入驗證、CORS 白名單、稽核 | security review |
| 5.4 | 夜間成本 | 正式環境 連續 3 晚 DO Duration 夜間平線 | dashboard 截圖 |

### M4／M5 實作狀態（2026-10-27）

測試數：Vitest **304**（api 229、display 39、shared 36）＋ node:test 8（T12 6、密鑰掃描 2）＋ `lib.test.sh` 47 ＋ Playwright **43**（M3 時 32）。
視覺紀錄見 [visual-review-M4.md](visual-review-M4.md)。✅＝本機完成並有測試；⏳＝剩餘須部署後在正式環境／實機驗證；❌＝未做。

| # | 狀態 | 說明 |
|---|---|---|
| 4.1 | ⏳ | Worker 驗 Access JWT（`Cf-Access-Jwt-Assertion`／`CF_Authorization`；RS256＋JWKS 快取與輪替、aud、iss、exp、nbf、拒絕 alg 混淆）＋ `ACCESS_ALLOWED_EMAILS` 再比一次（production 名單為空即拒絕）；本機 `DEV_BYPASS_ACCESS` 只在 `ENV=local`、production 帶旗標整個 Worker 500。兩種模式皆有 Vitest（`access.test.ts`）。寫入需 `x-qcs-admin`＋Origin 檢查（CSRF，ADR-047）。**正式網址（2026-10-27）部分驗證**：bootstrap 建立 Access 應用 `call-admin`＋policy `call-admin-allow`；未登入 `call-admin.jjoy.ai` 與其 `/api/*` 皆 302 到 Access（route 優先於前端 Worker 的 Custom Domain，ADR-050）、直打 `call-api.jjoy.ai/api/admin/me` 回 401；Access 登入頁顯示 email 驗證碼。**名單內 email 實際以 One-time PIN 登入、名單外 email 被拒：待人工驗證** |
| 4.2 | ⏳ | 總後台 API＋手機直版前端：品牌、建立門店（初始密碼只顯示一次）、列表（搜尋、狀態篩選、警示優先）、詳情、停用／恢復、到期（＋30 天／＋1 年／不到期）、面板／人員上限、功能開關（含「內部測試門店」）、廣告容量、店長帳號（新增／重設密碼／停用）、封存刪除（ADR-043）、稽核查詢。寫入即同步 KV＋DO：停用與到期 WS 立即 4003（Vitest）。面板在線來自 DO、無法出聲 > 5 分鐘警示（ADR-045）。**正式環境 60 秒內各節點 403 待實測** |
| 4.3 | ⏳ | 每請求 AE data point（mock binding 測）、DO 計數（rpc／alarms／rowsW）併入既有 state 列、非營業時間喚醒寫 AE、推播每批依店計數、`usage_hourly`→`daily`→`monthly`、Cron 分派、查詢時補算（ADR-044）。**T18 通過**（開／關計量 rows written、alarm、meta 列相同）。**與 Cloudflare 帳號數字誤差 < 20% 需正式環境跑一週比對；係數（每事件 0.05 秒等）待校正；GraphQL 預填帳單未做（需 0.5）** |
| 4.4 | ⏳ | 用量與成本頁（實際／估算並列、活躍店數、每店平均、排行 3 種、30 日趨勢、警示 6 種）、每店用量頁（今日 AE 即時、本月、30 日長條＋每日明細）、帳單輸入與分攤（12 項、月費由活躍門店平均）、CSV（每月／每日，BOM、防公式注入）。**人為製造夜間喚醒 → 警示：Vitest 以真 DO 驅逐／喚醒 12 次重現並通過**；正式環境實測待部署 |
| 5.1 | ⏳ | `scripts/load/local-load.mjs` 本機實測（300 號／5 分鐘＋50 面板，SMOKE1）：取號 p95 20 ms、**叫號到全部 50 面板 p95 8 ms**、0 錯誤；10 倍尖峰（30 秒 300 號）p95 7 ms。本機為單一 workerd 行程，只代表程式無瓶頸。**k6 版 `scripts/load/k6-call.js` 待部署後對正式環境跑** |
| 5.2 | ⏳ | T13＋`m5.test.ts`：QR 取號→叫號→查看手機→完成＋人員代取號→關店→q-history 後，D1 **每張表每一欄**都找不到姓名／手機原文，DO 原文已清空。`scripts/pii-check.sh`（本機已跑通過；正式環境抽查待部署） |
| 5.3 | ✅ | 獨立安全審查（無 CRITICAL／HIGH；3 MEDIUM、5 LOW 全部修正，見 ADR-047）；`check-secrets.mjs` 納入 `pnpm test`；CORS 白名單測試；每店 PIN 失敗限流（ADR-046）；錯誤不洩漏內部訊息；前端 `_headers` 安全標頭（nosniff、DENY frame、Referrer-Policy、Permissions-Policy；ADR-050 改 assets-only Worker 後照樣生效）；部署腳本 `call-` 安全閘與憑證隔離（ADR-049） |
| 5.4 | ⏳ | 需正式環境連續 3 晚 DO Duration（dashboard）；DO 夜間喚醒 AE 點與總後台警示已就緒，可作為輔助觀察 |
| 業主追加 | ✅ | 同一毫秒取號排序（ADR-042，`queue-order.test.ts` 14 項）；顧客手機圖片（ADR-048，E2E 5 項）；部署命名 jjoy.ai／`call-`／只有正式環境（ADR-049） |

## M6 — 一鍵佈署腳本實作與實測

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 6.1 | `bootstrap.sh` | 在**全新 Cloudflare 帳號**從零跑完；再跑第二次全部顯示「已存在，略過」且 secrets 未被覆蓋 | 兩次執行紀錄 |
| 6.2 | `deploy.sh`＋`smoke.sh` | 正常部署通過；故意部署壞版本時自動 rollback 且服務不中斷 | 正式環境 演練紀錄 |
| 6.3 | `rollback.sh` | Worker 回到指定版本；前端回滾（`--frontends`，ADR-050 改 Worker 後取代 Pages 回滾）實測並修正文件 | 演練紀錄 |
| 6.4 | GitHub Actions | 只跑測試（憑證只在業主電腦的 cf.env，部署一律手動 `deploy.sh`，ADR-049） | Actions 紀錄 |
| 6.5 | 業主教學實測 | 由非工程師依 10-deploy-guide 獨立完成正式環境佈署 | 過程中卡住的點全部回寫文件 |

## M7 — Demo 資料包（見 13-demo-seed）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 7.1 | 虛構品牌視覺（名稱商標檢索、SVG Logo、配色） | 無同名註冊商標衝突 | 檢索結果存檔 |
| 7.2 | 蒐集 5～8 張廣告圖＋1～2 支短影片 | 全部符合規格；`assets/demo/CREDITS.md` 每張有來源 URL 與授權 | 人工逐張審核：無真實品牌元素、無可辨識人臉 |
| 7.3 | `seed:demo` 腳本（本機／正式環境 DEMO 門店，`--reset`） | 重跑冪等；正式環境只動 `DEMOSK*` 門店並需 `--confirm`（只有一套環境，ADR-049） | 本機與正式環境各跑兩次 |
| 7.4 | 模擬叫號（原規劃 `demo:simulate` 腳本；ADR-051 改為伺服器端 DO alarm） | 面板連續 30 分鐘自動叫號，語音、廣告讓位正常 | 正式環境 實機錄影 |

### M6／M7 實作狀態（2026-10-27）

首次實際部署到共用 Cloudflare 帳號的 `*.jjoy.ai`。前端改 assets-only Worker、Analytics Engine 暫不綁定（ADR-050）；模擬叫號改 DO alarm（ADR-051）。
正式網址截圖紀錄見 [visual-review-M6.md](visual-review-M6.md)。✅＝已在正式環境達成；⏳＝部分完成，剩餘項目列於說明。

| # | 狀態 | 說明 |
|---|---|---|
| 6.1 | ✅ | `bootstrap.sh` 在**共用帳號**（不是全新帳號；其他產品的資源不受影響，全部 `call-` 安全閘）從零建出 D1／KV／R2（CORS、`call-media` 自訂網域）／4 Queues／migration／Worker／secrets／Access。**兩次執行皆有紀錄**：第二次既有資源顯示「已存在，略過」、金鑰類 secret 顯示「已存在，不覆蓋」，並補上 Access team domain。差異：token 無 Access Organizations 權限 → One-time PIN 不由腳本建立（登入頁預設已有 email 驗證碼）、team domain 改由登入導向讀取 |
| 6.2 | ✅ | `deploy.sh`＋`smoke.sh` 正常部署通過（smoke 6 項：health 版本、WS hello／pong、5 前端、admin `/api/*` 擋、API 401、media CORS）。**自動回滾在一次真實失敗中觸發**（smoke 的 WebSocket 檢查失敗 → `wrangler rollback` 到前一版），非刻意部署壞版本。教訓：bootstrap 第一個 Worker 版本早於 `secret put`、不含 secrets，不可作為回滾目標（08 §4.2） |
| 6.3 | ✅ | 回滾演練：部署 `33b408e` → `rollback.sh production <version-id>` → `/health` 回 `22f40c1`、smoke 6/6 通過；前端 `--frontends` 回滾以 `call-staff` 實測；再 `deploy.sh` 前滾回最新。文件已依實測修正（08 §4.3、10 步驟 14） |
| 6.4 | ⏳ | `.github/workflows/ci.yml` 已存在：每次 push／PR 跑 hibernation 靜態檢查＋型別檢查＋`pnpm test`，不部署（ADR-049）。**GitHub 上的 Actions 執行紀錄本次未查看**；檔內註解「deploy.yml 屬 M6，尚未加入」已被 ADR-049 取代（不做 CI 部署） |
| 6.5 | ⏳ | 10-deploy-guide 已依實際指令與輸出改寫；**仍需由非工程師獨立照做一次**並回寫卡住的點 |
| 7.1 | ⏳ | 虛構品牌「鮮迴壽司／Senkai Sushi」、自製 SVG Logo（＋512 PNG）、配色（藏青 `#1F2A44`、紅 `#C8102E`）已完成；**TIPO 商標檢索「鮮迴」尚未做**（對外公開展示前必做，衝突就換名） |
| 7.2 | ✅ | `assets/demo`：8 張廣告圖（1080×720 JPEG）＋2 支影片（1080×720 H.264、無音軌、約 14 秒）＋Logo；`CREDITS.md` 逐檔列來源頁、直連、作者、授權（Pexels License）、處理方式。**保留事項**：ad-06 作者名未完全查證（兩種拼法）；ad-03 以烤鯖魚照片示意秋刀魚；video-01 原片拍攝於真實迴轉壽司店，已裁掉人物與招牌、模糊菜單牌，仍有不可辨識的盤面小圖樣與無臉手臂 |
| 7.3 | ✅ | `pnpm seed:demo`（本機）與 `pnpm seed:demo --env production --confirm`（正式）各跑兩次：UPSERT 冪等、密碼／PIN／裝置 token 沿用輸出檔；正式環境寫入前安全檢查（同 id／門店碼的非 DEMO 門店即中止）；裝置經真實 API 配對。`--reset`、`--skip-media` 已實作。**待辦**：正式環境櫃台名稱仍是第一次 seed 的「1 號櫃台（內用）」（人員端頁首換行），下次重跑 seed 會改成「1 號櫃台」 |
| 7.4 | ⏳ | 伺服器端模擬叫號（ADR-051，`features.demoSimulate`、`DEMO_SIM_EVERY_SEC` 預設 20 秒）在正式網址運作：`pnpm e2e:prod` 的模擬叫號項目確認台北中山店面板自動出現叫號與語音事件。**實體電視連續 30 分鐘錄影（語音、廣告讓位）尚未做** |

## M8 — 叫號機 Android 包裝 App＋硬體建議清單（ADR-027）

| # | 任務 | 完成條件 | 驗證方式 |
|---|---|---|---|
| 8.1 | `apps/display-android`（WebView、免手勢播放、HOME launcher、immersive、常亮、斷網重連、網址白名單、JS bridge） | **冷開機到第一次叫號出聲，全程不需觸碰** | 3 款裝置各做 5 次：斷電 → 通電 → 遠端叫號 → 聽到叮咚與語音 |
| 8.2 | 斷電／斷網恢復 | 斷網 10 分鐘後恢復，面板自動重連並能出聲；斷電後來電自動開機進 App | 實機 |
| 8.3 | 音訊被擋回報 | 在一般瀏覽器開面板不點擊 → 門店後台與總後台 1 分鐘內出現「無法出聲」警示；點擊後警示消失 | 正式環境 實測 |
| 8.4 | 替代方案驗證：Fully Kiosk Browser、Chromium kiosk＋`--autoplay-policy` | 各自冷開機免觸碰出聲（或記錄失敗原因） | 實機紀錄回寫 05-apps |
| 8.5 | 硬體建議清單 | 至少 1 款電視盒、1 款平板、1 款迷你電腦通過 8.1～8.2，連續 7 天 12 小時播放廣告＋叫號無當機 | 實測報告（型號、價格、Android 版本、RAM、溫度） |

硬體初步建議（待 8.5 驗證）：Android 9 以上且 WebView 可經 Play 商店更新、RAM ≥ 2 GB（建議 4 GB）、
支援 1080p H.264 硬體解碼、有線網路優先、HDMI 輸出（聲音走電視喇叭或外接喇叭）、**斷電來電自動開機**（電視盒需確認；迷你電腦需 BIOS「AC Power On」）。

## 後續（不在 MVP）

多品牌 UI、台語／英語語音、預約取號、回訪統計、報表 NDJSON 匯出 R2、方案分級收費自動化（ADR-020）。

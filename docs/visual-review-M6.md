# M6 正式網址視覺紀錄

日期：2026-10-27。執行：`pnpm e2e:prod`（`e2e/playwright.production.config.ts`，5 項全過），對象是正式網址 `https://call-*.jjoy.ai`＋Demo 資料包（[13-demo-seed](13-demo-seed.md)）。
截圖在 `test-results/production/prod-*.png`，每張由 AI 逐張開圖檢查。每頁另有自動量測（`prod.spec.ts` 的 `issues()`）：無水平溢出、畫面文字不含 `NaN`／`undefined`／`[object Object]`、無破圖。

| 對象 | Viewport | 門店 |
|---|---|---|
| 面板 | 1080×1920 | 台中公益店（主流程）、台北中山店（模擬叫號） |
| 顧客、人員、門店後台、總後台 | 390×844（DPR 2、觸控、Android UA） | 台中公益店；顧客頁 DEMO 標示另以台北中山店 |

## 逐張紀錄

| 檔案 | 檢查內容 | 結果 |
|---|---|---|
| `prod-display-01-idle.png` | 頁首 Logo＋店名＋時鐘；「等待叫號」與掃碼提示；廣告區載入 call-media 圖片（鮪魚握壽司）；QR、近期叫號「尚無」、等候人數 | 圖片正常載入。**問題 1**：DEMO 標示壓在廣告標題上（見下） |
| `prod-display-02-called.png` | 叫號後大字 `A001`、「請到 1 號櫃台」；廣告區正在播影片（ad-video-01） | 大字與櫃台正確。同一問題 1（壓到影片字幕帶「新鮮現做…」） |
| `prod-display-03-badge-header.png` | 修正後版本：DEMO 標示移到頁首時鐘左側；大字 `A002`、近期叫號 `A001 1 號櫃台`；廣告標題「鮪魚握壽司／每日現切・鮮紅油亮」完整可讀 | 問題 1 已修正。畫面中央的「尚未啟用聲音」卡片屬預期（見下） |
| `prod-display-zs-simulated.png` | 台北中山店模擬叫號：無人操作，面板自動出現 `B001`「請到 3 號櫃台」，音訊事件有記錄 | 模擬叫號運作（ADR-051）；外帶走 3 號櫃台符合設定。截圖時間早於問題 1 修正，仍見標示重疊 |
| `prod-customer-01-service.png` | 掃面板 QR 進入：Logo、「DEMO・虛構品牌」橫條、步驟 1/3、A 內用／B 外帶與等候人數 | 正常 |
| `prod-customer-02-form.png` | 主視覺（廣告圖）、服務與等候數、姓名、手機、個資同意、「開啟提醒並取號」 | 正常；送出鈕在首屏 |
| `prod-customer-03-ticket.png` | 號碼 `A001`、前面 0 位、響鈴提醒卡、開啟背景提醒、廣告輪播（3 點指示）、取消號碼 | 正常 |
| `prod-customer-04-called-alert.png` | 全螢幕紅底「輪到您了！A001 請到 1 號櫃台」＋「我知道了」 | 正常 |
| `prod-customer-05-done.png` | 「服務已完成，謝謝光臨」 | 正常 |
| `prod-customer-zs-01-home.png` | 台北中山店顧客頁：Logo 與 DEMO 橫條 | 正常 |
| `prod-staff-01-desk.png` | 人員端：櫃台選單、代客取號、人員名、等候清單 `A001 測試顧客` | **問題 2**：頁首櫃台名稱「1 號櫃台（內用）」換成兩行、「代客取號」也換行（見下） |
| `prod-staff-02-called.png` | 目前 `A001`、遮罩手機＋眼睛按鈕、狀態「已叫號」、操作鈕啟用 | 手機為遮罩格式；同一問題 2 |
| `prod-store-01-login.png` | 門店後台登入（台中公益店店長 email，密碼遮蔽） | 正常 |
| `prod-store-02-board.png` | 即時隊列：A／B 等候數、2 個櫃台卡（含叫下一號等操作）、空狀態說明、底部分頁 | 正常；櫃台卡也顯示長名稱「1 號櫃台（內用）」，單行未溢出 |
| `prod-store-03-ads.png`（整頁） | 容量 4.5 MB／500 MB、顧客手機預覽（3 張輪播）、10 個素材（8 圖 2 影片）、「顧客手機」標籤在 3 張圖 | 素材數與 manifest 一致。影片縮圖為黑底「影片」字樣（未產生縮圖）；整頁截圖中固定的上傳鈕與底部分頁出現在中段，屬截圖產物 |
| `prod-store-04-devices.png` | 配對新裝置表單、叫號面板 1/3 台「DEMO 面板」、人員手機「DEMO 櫃台手機」，皆 2026/10/27 配對 | 正常；裝置是 seed 經真實 API 配對的結果 |
| `prod-store-05-reports.png` | 今日取號 1、已完成 1（本次主流程那一張）、A／B 分項；歷史近 7 天「這段期間沒有資料」 | 正常：7 天假歷史只灌在台北中山店，公益店歷史本來就是空的 |
| `prod-admin-01-access-login.png` | 未登入開 call-admin → Cloudflare Access「Log in to call-admin」、Email 欄、「Send login code」 | Access 保護生效、登入方式為 email 驗證碼（One-time PIN）；自動化到此為止，實際收碼登入待人工 |

## 發現的問題與處理

1. **面板 DEMO 標示壓到廣告標題**（`prod-display-01`、`02`、`zs-simulated`）：標示原本疊在廣告區左下，蓋住廣告的標題與影片字幕。
   **已修正**（commit `33b408e`）：標示移到頁首、時鐘旁（`prod-display-03-badge-header.png`），廣告區不再被遮。廣告圖檔右上角自帶的小「DEMO・虛構品牌」是素材本身的一部分，保留。
2. **人員端頁首換行**（`prod-staff-01`、`02`）：正式環境的櫃台名稱是第一次 seed 寫入的「1 號櫃台（內用）」，390 寬時頁首擠成兩行。
   **程式已修正**（`seed-demo.mjs` 改為「N 號櫃台」），**正式環境資料尚未更新**：下次執行 `pnpm seed:demo --env production --confirm` 才會套用（目前正式環境用於錄影，未重跑）。

## 預期行為（不是問題）

- **「尚未啟用聲音」卡片**（`prod-display-03`）：一般瀏覽器在使用者沒有互動前不允許自動播放，面板因此提示按遙控器 OK 鍵或點一下畫面。
  這是非 kiosk 瀏覽器的預期行為；叫號機 App（ADR-027）或帶 `--autoplay-policy=no-user-gesture-required` 的 kiosk 瀏覽器不會出現。
- 報表頁歷史為空、等候人數為 0：測試開始時 Demo 門店沒有排隊中的號碼。

## 未涵蓋

實體電視聲音、手機實機掃 QR、iPhone 推播、Access 實際收碼登入、連續 30 分鐘模擬叫號錄影——見 [09-roadmap](09-roadmap.md)「M6／M7 實作狀態」與 [10-deploy-guide-for-owner](10-deploy-guide-for-owner.md) C 段。

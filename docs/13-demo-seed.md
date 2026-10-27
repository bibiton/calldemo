# 13 — Demo 資料包

目的：對外展示時，叫號面板有完整的品牌感（迴轉壽司連鎖風格的廣告圖片與影片、俏皮語音），並能自動模擬叫號。
**已實作（M7，2026-10-27）**：素材在 `assets/demo/`、種子腳本 `apps/api/scripts/seed-demo.mjs`（`pnpm seed:demo`）、模擬叫號在 StoreQueueDO（ADR-051）；
本機與正式環境各跑過兩次。狀態見 [09-roadmap](09-roadmap.md)「M6／M7 實作狀態」。登入方式見 README「DEMO 網址與登入方式」。
M1 階段的本機 seed（`apps/api/scripts/seed-local.mjs`）只用**自製色塊 SVG＋ffmpeg 測試圖樣影片**（`apps/display/public/demo-ads/`），門店名為「示範門市」，不含任何真實或虛構品牌素材；與本資料包互不影響。

## 1. 虛構品牌（不可冒用真實品牌）

| 項目 | 內容 |
|---|---|
| 品牌名 | **鮮迴壽司**（虛構，英文 *Senkai Sushi*），`brand_demo` |
| 風格參考 | 迴轉壽司連鎖的一般視覺語彙：紅白／藏青配色、壽司特寫、季節限定、套餐促銷 |
| 配色 | 主色藏青 `#1F2A44`、強調紅 `#C8102E`、底色白 `#FFFFFF`（2 個強調色以內；`assets/demo/manifest.json` 的 `brand.colors`） |
| Logo | 自行設計的文字標：藏青圓環（迴轉帶意象）＋三個紅色圓點（盤子）＋「鮮迴」＋ SENKAI。`assets/demo/logo/logo.svg`＋`logo-512.png`（白底 512×512） |

**禁止**：使用爭鮮（或任何真實品牌）的名稱、Logo、商標、門市照片、菜單照片、官方廣告素材或可能讓人誤認為該品牌的元素。
Demo 畫面固定顯示「DEMO・虛構品牌」標示（`features.demo`：面板頁首時鐘旁、顧客頁）。
對外公開展示前，以經濟部智慧財產局商標檢索確認「鮮迴」沒有同名註冊商標（**未查證，尚未檢索**）；若有衝突就換名——品牌名在 `seed-demo.mjs` 的 `BRAND` 與 `manifest.json`，
但廣告圖上的品牌字與 Logo 是烘進圖檔的，換名需重新產生素材。

## 2. 素材來源與授權

**實際使用**：全部照片與影片取自 [Pexels](https://www.pexels.com/license/)（Pexels License：可商用、可修改、免署名；不得未經修改單獨轉售、不得暗示照片中人物或品牌背書），
其餘為自製。**未使用 Unsplash 與 Pixabay 站內素材**（CREDITS 中的「Pixabay」是 Pexels 上的上傳者帳號名）。

| 來源 | 授權 | 用途 |
|---|---|---|
| [Pexels](https://www.pexels.com/license/) | Pexels License | 壽司特寫照片 8 張、短影片 2 段（ad-video-02 只用 4 秒片段） |
| 自行製作 | 自有 | Logo、文字版面、價格標、季節限定標語、品牌結尾卡；字型 Noto Sans／Serif CJK TC（SIL OFL） |
| [Unsplash](https://unsplash.com/license)、[Pixabay](https://pixabay.com/service/license-summary/) | 各自授權 | 允許的來源，本包未使用 |

- 逐檔紀錄在 **`assets/demo/CREDITS.md`**：檔名、來源頁、直連檔案、作者、授權、下載日期（2026-10-27）、處理方式。新增素材一律補這份。
- 不使用畫面中出現其他品牌 Logo、可辨識人臉或店招的素材。
- 照片上的文字（「秋季限定」「平日午間套餐 $199」等）與價格一律虛構、自行排版疊加。
- **已知保留事項**（CREDITS「已知殘餘風險」）：ad-06 作者名未完全查證（列表與頁面拼法不同）；ad-03 以烤鯖魚照片示意秋刀魚；
  ad-video-01 原片拍攝於真實迴轉壽司店，已裁掉人物臉部與招牌、模糊背景菜單牌，仍可見不可辨識的盤面小圖樣與無臉手臂／白衣。

## 3. 素材規格（ADR-016、ADR-028）與實際產出

| 類型 | 規格 | 實際（`assets/demo/`） |
|---|---|---|
| 廣告圖片 | 5～8 張，**1080×720（3:2）**、WebP 或 JPEG、每張 ≤ 800 KB（上限 5 MB） | `ads/ad-01`～`ad-08` 共 8 張 JPEG 1080×720，每張約 85～135 KB |
| 廣告影片 | 1～2 支，**1080×720（3:2）**、MP4 H.264、無音軌、10～20 秒、每支 ≤ 8 MB（上限 50 MB） | `video/ad-video-01.mp4`（14.0 秒、約 2.4 MB）、`ad-video-02.mp4`（14.6 秒、約 1.4 MB），H.264 High、無音軌 |
| Logo | SVG ＋ 512×512 PNG | `logo/logo.svg`、`logo/logo-512.png` |
| 清單 | — | `manifest.json`：每檔 `kind`、`mime`、尺寸、標題、`durationMs`（圖片 6 秒）、`showOnCustomer`（ad-01、02、07 在顧客頁輪播） |

主題：鮪魚握壽司、鮭魚親子丼、秋季限定炙烤秋刀魚、平日午間套餐、外帶綜合盒、新品雙拼握壽司、炙燒系列、會員集點（皆虛構）；影片：迴轉壽司 每盤 $40 起、品牌短片。

影片轉檔參考（ffmpeg，裁成 1080×720、控制大小）：

```bash
ffmpeg -i in.mp4 -vf "scale=1080:720:force_original_aspect_ratio=increase,crop=1080:720" \
  -c:v libx264 -profile:v high -preset slow -crf 26 -an -movflags +faststart -t 15 out.mp4
```

## 4. Demo 種子內容（`seed-demo.mjs` 的固定範圍）

| 資料 | 內容 |
|---|---|
| 品牌 | 鮮迴壽司（`brand_demo`，`ads_push_enabled = 0`） |
| 門店 | 鮮迴壽司 **台北中山店** `st_sk_zs`／`DEMOSK01`、**台中公益店** `st_sk_gy`／`DEMOSK02`、**高雄左營店** `st_sk_zy`／`DEMOSK03`（皆虛構）；時區 Asia/Taipei，每天營業 **10:00–22:00** |
| 服務類別 | **A 內用**、**B 外帶** |
| 櫃台 | 中山店：1、2 號（內用）、3 號（外帶）；公益店、左營店：1 號（內用）、2 號（外帶）。名稱一律「N 號櫃台」 |
| 帳號 | 每店 1 位店長（`senkai-<zs／gy／zy>@example.com`，密碼隨機產生）、2 位人員（6 位 PIN 隨機產生、店內不重複、不用 000000 這類同數字） |
| 裝置 | 每店 1 台面板＋1 支人員手機。本機：以 `.dev.vars` 的 `JWT_SECRET` 直接簽 token；正式環境：**走真實 API 配對**（`JWT_SECRET` 只存在 Worker secret）。已有且仍有效的 token 沿用 |
| 廣告 | **每店自己的門店層 playlist**（manifest 10 個素材依序），R2 key `ads/<storeId>/<sha256>.<ext>`；Logo `logos/brand_demo/<sha256>.png`；上傳時帶 `Cache-Control: public, max-age=31536000, immutable` |
| 語音 | `mode: "fun"`、`funPrefixProb: 0.5`、`venue: "food"`、主題包 `hungry`／`anticipation`／`warm`、唸 2 次、音量 0.8 |
| 功能開關 | `push`、`ads`、`voice`、`showMaskedName`、`demo` 全開；`demoSimulate` 只有中山店開 |
| 上限 | 裝置 3、人員 10、廣告容量 500 MB、前面剩 3 位時提醒 |
| 歷史 | 只有中山店：前 7 天的 `tickets_history` 假資料（固定亂數種子；只有遮罩姓名、無手機），報表頁有圖可看（`daily_stats` 由查詢補算，ADR-039） |

## 5. 模擬叫號（ADR-051：伺服器端 DO alarm，取代原規劃的 `pnpm demo:simulate`）

原規劃要有人開著電腦跑腳本連 WS，電腦睡眠就停；改為 StoreQueueDO 自己排 alarm（與關店 alarm 共用，取較早者）。

- **開關**：`features.demo` 且 `features.demoSimulate` 都為 true 才生效（`apps/api/src/do/demo-sim.ts`）；一般門店永遠不會模擬。
  總後台 → 門店詳情 → 功能開關「模擬叫號」可切換（只有 DEMO 門店有效）。Demo 資料包預設只開台北中山店。
- **條件**：營業時間內、且**至少一台面板連線**。非營業時間排到下一次開店；面板全斷線即停止，下一台面板連上再開始。
- **節奏**：每 `DEMO_SIM_EVERY_SEC` 秒（Worker var，預設 20，限制 10～600）一次；等候中少於 4 張時補一張號碼（隨機 A／B、虛構姓名），
  然後約 85% 叫下一號、10% 重叫、5% 過號——走與人員指令相同的路徑，面板照常顯示叫號大字、近期叫號、語音前綴、廣告讓位。
- **成本**：只有開模擬的門店、營業時間內約 20 秒一次 alarm；夜間為 0。
- **注意**：真實顧客在中山店取號時，模擬也可能叫到他（展示用門店，可接受）。
- 驗證：`pnpm e2e:prod` 的「模擬叫號（台北中山店）」項目（只在 10:00–22:00 執行）。

## 6. 一鍵灌入

```bash
pnpm seed:demo                                        # 本機（wrangler dev 的本機 D1／R2／KV）
pnpm seed:demo --env production --confirm             # 正式環境（ADR-049 只有一套）：只動 DEMOSK* 門店
pnpm seed:demo [--env production --confirm] --reset   # 刪除 DEMO 門店全部資料列與 R2 素材、刪輸出檔
#   選項：--skip-media（不重傳 R2）、--persist-to <dir>（本機）
```

流程：
1. （正式環境）**安全檢查**：查詢同 id 或同門店碼的既有門店，只要有一家不是本腳本的 DEMO 門店（`features.demo = true` 且 id／碼成對）就中止，什麼都不寫。
2. D1：品牌、3 家門店、服務、櫃台、店長與人員、每店廣告清單（單一 SQL 檔，**UPSERT**；不用 `INSERT OR REPLACE`——D1 外鍵沒有 CASCADE，REPLACE 會刪父列）。
3. R2：Logo＋10 個素材 × 3 店（`--skip-media` 略過）。
4. KV：刪除 `license:<storeId>`、`storecode:<code>` 快取（下一次請求由 D1 重建；isolate 記憶體快取最多 60 秒）。
5. 裝置：配對面板與人員手機（見 §4）。
6. 輸出：每家店的門店碼、面板網址、人員網址與 PIN、店長帳號；**密碼與完整裝置網址只寫進輸出檔**：
   本機 `apps/api/.wrangler/demo-output.json`；正式環境 `~/.config/queue-call-system/demo-output.json`（權限 600，不在 repo，不要上傳）。

- **安全範圍**：只讀寫固定的 `st_sk_*`／`DEMOSK01～03`／`brand_demo`；`--reset` 刪 R2 時只刪 `ads/st_sk_*`、`logos/brand_demo/` 開頭的物件。
- **冪等**：可重複執行；密碼、PIN、裝置 token 首次產生後存在輸出檔，重跑沿用（刪掉輸出檔才會重新產生）。`qr_key_version`、帳號的 `token_version` 不被覆寫。
- **正式環境憑證**：只讀 `~/.config/queue-call-system/cf.env`（權限須 600），wrangler 以暫存 HOME＋環境變數 token 執行，不用全域 `wrangler login`，不印出 token。
- `pnpm e2e:prod` 讀同一份正式環境輸出檔，所以要先跑過 seed。
- **現況（2026-10-27）**：正式環境櫃台名稱仍是第一次 seed 的「1 號櫃台（內用）」這種長名稱（人員端頁首會換行）；程式已改為「1 號櫃台」，
  下次執行 `pnpm seed:demo --env production --confirm` 即更新（UPSERT 覆寫名稱）。

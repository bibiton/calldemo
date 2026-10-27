# 13 — Demo 資料包

目的：對外展示時，叫號面板有完整的品牌感（迴轉壽司連鎖風格的廣告圖片與影片、俏皮語音），並能自動模擬叫號。
**這份只是規劃**；素材蒐集與種子腳本列在 [09-roadmap](09-roadmap.md) M7。
M1 階段的本機 seed（`apps/api/scripts/seed-local.mjs`）只用**自製色塊 SVG＋ffmpeg 測試圖樣影片**（`apps/display/public/demo-ads/`），門店名為「示範門市」，不含任何真實或虛構品牌素材。

## 1. 虛構品牌（不可冒用真實品牌）

| 項目 | 內容 |
|---|---|
| 品牌名 | **鮮迴壽司**（虛構，英文 *Senkai Sushi*） |
| 風格參考 | 迴轉壽司連鎖的一般視覺語彙：紅白／藏青配色、壽司特寫、季節限定、套餐促銷 |
| 配色 | 主色藏青 `#1F2A44`、強調紅 `#C8102E`、底色白 `#FFFFFF`（2 個強調色以內） |
| Logo | 自行設計的文字標（「鮮迴」二字＋簡單圓形迴轉意象），以 SVG 繪製 |

**禁止**：使用爭鮮（或任何真實品牌）的名稱、Logo、商標、門市照片、菜單照片、官方廣告素材或可能讓人誤認為該品牌的元素。
Demo 畫面角落固定顯示「DEMO・虛構品牌」浮水印。
對外公開展示前，以經濟部智慧財產局商標檢索確認「鮮迴」沒有同名註冊商標（**未查證**）；若有衝突就換名，所有素材以設定檔的品牌名產生，換名只改一處。

## 2. 素材來源與授權

| 來源 | 授權 | 用途 |
|---|---|---|
| [Pexels](https://www.pexels.com/license/) | Pexels License（可商用、免署名；不可單獨轉售素材） | 壽司特寫照片、短影片 |
| [Unsplash](https://unsplash.com/license) | Unsplash License（可商用、免署名；不可彙編成競爭圖庫） | 壽司、餐桌照片 |
| [Pixabay](https://pixabay.com/service/license-summary/) | Pixabay Content License（可商用、免署名） | 照片、影片 |
| 自行製作 | 自有 | 文字版面、價格標、季節限定標語 |

（各圖庫授權摘要以其頁面為準，本文件撰寫時未逐條查證最新條款——**蒐集素材時逐張確認並記錄**。）

- 每一張素材在 `demo/assets/SOURCES.md` 記錄：檔名、來源 URL、作者、授權名稱、下載日期。
- 不使用畫面中出現其他品牌 Logo、可辨識人臉或店招的素材。
- 照片上的文字（「季節限定」「套餐 $199」等）與價格一律虛構、自行排版疊加。

## 3. 素材規格（符合 ADR-016）

| 類型 | 數量 | 規格 |
|---|---|---|
| 廣告圖片 | 5～8 張 | **1080×720（3:2，ADR-028）**、WebP 或 JPEG、每張 ≤ 800 KB（上限 5 MB） |
| 廣告影片 | 1～2 支 | **1080×720（3:2）**、MP4 H.264、無音軌或靜音、10～20 秒、每支 ≤ 8 MB（上限 50 MB） |
| Logo | 1 | SVG ＋ 512×512 PNG |

建議主題：鮪魚握壽司特寫、鮭魚親子丼、季節限定（秋季：秋刀魚）、平日午間套餐、外帶組合、新品上市、會員活動（皆虛構）。

影片轉檔參考（ffmpeg，將直式素材裁成 1080×1920、控制大小）：

```bash
ffmpeg -i in.mp4 -vf "scale=1080:720:force_original_aspect_ratio=increase,crop=1080:720" \
  -c:v libx264 -profile:v high -preset slow -crf 26 -an -movflags +faststart -t 15 out.mp4
```

## 4. Demo 種子內容

| 資料 | 內容 |
|---|---|
| 品牌 | 鮮迴壽司（`brand_demo`） |
| 門店 | 中山店、信義店、板橋店（3 家，皆虛構），時區 Asia/Taipei，營業 11:00–21:30 |
| 服務類別 | **A 內用**、**B 外帶** |
| 櫃台 | 中山店：1～3 號（1、2 號內用帶位，3 號外帶）；其他兩店各 2 個 |
| 帳號 | 每店 1 位店長（`demo-<店>@example.com`）、2 位人員（PIN `000000` 起，**只在 demo 門店有效**） |
| 裝置 | 每店 1 台已配對面板（device token 由種子腳本產生並印出可直接開啟的網址） |
| 廣告 | §3 的素材，品牌層 playlist（`ads_push_enabled=1`），各店接受品牌下發 |
| 語音 | `mode: "fun"`、`funPrefixProb: 0.5`、預設啟用美食相關主題包（tag 以 `assets/audio/manifest.json` 為準） |
| 功能開關 | `features.demo = true`（顯示 DEMO 浮水印、允許模擬叫號） |
| 歷史 | 每店近 14 天的 `daily_stats` 假資料，讓報表頁有圖可看 |

## 5. 模擬叫號

`pnpm demo:simulate --store 中山店 --every 20`

- 以 demo 人員身分連 WS，每 N 秒：`createTicket`（隨機 A/B、虛構姓名）→ 下一輪 `callNext` →
  隨機 `startServing`／`finish`，偶爾 `recall`、`skip`，讓面板展示叫號大字、近期叫號、語音前綴、廣告讓位。
- 只對 `features.demo = true` 的門店生效（DO 端拒絕非 demo 門店的模擬來源），production 一般門店不可能被誤灌。

## 6. 一鍵灌入

```bash
pnpm seed:demo                 # 本機（wrangler dev 的本機 D1／R2／KV）
pnpm seed:demo --env staging   # staging
```

流程：
1. 套用 migration（本機）→ `INSERT OR REPLACE` 品牌、門店、類別、櫃台、帳號、裝置、語音設定、假統計
2. 上傳 `demo/assets/` 到 R2 `ads/brand_demo/<sha256>.<ext>` → 寫 `ad_assets`、`ad_playlists`、`ad_playlist_items`
3. 寫 KV `license:<storeId>`
4. 印出：3 家店的面板網址（含 device token）、店長帳號、人員 PIN、顧客 QR 測試方式

- 冪等：重跑會覆蓋 demo 資料，不影響其他門店。
- `pnpm seed:demo --reset`：刪除所有 `brand_demo` 資料（含 R2 物件）。
- **不支援 production**（腳本遇到 `--env production` 直接拒絕）。

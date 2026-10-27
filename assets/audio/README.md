# 叫號語音素材（預錄）

面板**只播放預錄檔**，不做即時語音合成。執行期成本為零（R2 出口免費、面板播過即快取），也不依賴任何 TTS 服務的可用性。

- 產生器：[`scripts/gen-audio.py`](../../scripts/gen-audio.py)
- 台詞與參數：[`scripts/audio-lines.json`](../../scripts/audio-lines.json)（**改台詞只改這個檔**）
- 清單：[`manifest.json`](manifest.json)（號碼以外的全部檔案＋拼接規則）、[`manifest.numbers.json`](manifest.numbers.json)（號碼片段明細）

## 聲音與格式

| 項目 | 值 | 理由 |
|---|---|---|
| 聲音 | `zh-TW-HsiaoChenNeural`（曉臻） | 台灣口音、語氣明亮。HsiaoYu 同句慢約 35%，叫號拖沓；YunJhe 實測在部分 rate/pitch 組合下穩定回傳空音訊（NoAudioReceived），批次產 7,000 段不可靠 |
| rate / pitch | `+6%` / `+3Hz` | 略快略高＝熱情但不尖。前綴、號碼、櫃台**全部同一組參數**，拼接時音色與速度一致 |
| 格式 | MP3、24 kHz、單聲道、32 kbps CBR | MP3 是 iOS Safari、Android 電視盒 WebView、Chromium 都能 `decodeAudioData` 的唯一保險格式；Opus 在舊 Safari／部分電視盒不保證。edge-tts 原生就是 24 kHz 單聲道，32 kbps 對語音清晰度足夠 |
| demo | 48 kbps | 只給人聽，不進面板 |

試聽比較：`demo/voices/`（同一句、4 種聲音／參數，檔名標「採用」的是現行設定）。

## 號碼怎麼錄：字首＋號碼整段

| 方案 | 檔數 | 大小 | 聽感 |
|---|---|---|---|
| A～F × 1～999 整段（「A二十三號」） | 5,994 | 約 33.2 MB | 一口氣念完，最自然 |
| 字首片段＋數字片段 | 26＋999 | 約 1 MB | 「欸。二十三號」字母單獨念會落成句尾調 |

**採用：A～F 整段（主路徑）＋ 字母／純號碼片段（後備）**。理由：

- 大小不是問題：一家店只用到自己的字首，每個字首 999 段約 5.4 MB；R2 儲存 10 GB 免費、出口免費。
- 產生成本一次性（約 1 小時，免費）。
- 後備：字首不在 A～F、或兩字元字首（data model 允許 1～2 字）→ `letter/{L}.mp3` 逐字母 ＋ `number/_/{NNN}.mp3`，間隔 30 ms。超出 1～999 → `speechSynthesis`。
- 數字讀法：台灣口語（二十三、一百零一、一百一十、**兩**百），由腳本轉成中文字再送 TTS，不讓 TTS 自己猜。

## 前綴（學海底撈句型、台詞原創）

叫號 = 叮咚 →〔前綴〕→ 號碼 → 櫃台／入座。前綴都以「…的來賓」或「…的」收尾，直接接號碼。

**語尾不掉調的做法**：每句前綴放進載體句「前綴，A二十三號。」合成，再切在逗號停頓處（以單獨合成的長度定位，找不到可信切點才退回單獨合成，manifest 的 `method` 會標示）。目前 56 句全部是 `carrier-cut`。
切下來的語尾是「話還沒說完」的語調，接號碼不會像兩句硬黏。

6 個主題包（manifest `prefixPacks`，`files[].pack`）：

**標準版**（`standard`，1 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.std` | 來賓 | any | 開 |

**餓了系**（`hungry`，11 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.hungry01` | 肚子正在打鼓的來賓 | food | 開 |
| `prefix.hungry02` | 胃已經在敲門的來賓 | food | 開 |
| `prefix.hungry03` | 口水快要忍不住的來賓 | food | 開 |
| `prefix.hungry04` | 聞到香味就走不動的來賓 | food | 開 |
| `prefix.hungry05` | 準備大吃一頓的來賓 | food | 開 |
| `prefix.hungry06` | 心裡已經拿好筷子的來賓 | food | 開 |
| `prefix.hungry07` | 肚子咕嚕咕嚕在催的來賓 | food | 開 |
| `prefix.hungry08` | 餓到眼睛都在發亮的來賓 | food | 開 |
| `prefix.hungry09` | 美食雷達已經全開的來賓 | food | 開 |
| `prefix.hungry10` | 準備開動的 | food | 開 |
| `prefix.hungry11` | 肚子比誰都準時的 | food | 開 |

**等很久系**（`waited`，8 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.wait01` | 耐心滿分的來賓 | any | 開 |
| `prefix.wait02` | 辛苦久等的來賓 | any | 開 |
| `prefix.wait03` | 一直很有耐心等我們的來賓 | any | 開 |
| `prefix.wait04` | 等待終於有回報的來賓 | any | 開 |
| `prefix.wait05` | 手機都快滑到沒電的來賓 | any | 開 |
| `prefix.wait06` | 排隊排到跟隔壁變好朋友的來賓 | any | 開 |
| `prefix.wait07` | 等到望眼欲穿的來賓 | any | 開 |
| `prefix.wait08` | 今天最有耐心的 | any | 開 |

**期待系**（`anticipation`，11 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.hope01` | 期待了一整天的來賓 | any | 開 |
| `prefix.hope02` | 今天最幸運的來賓 | any | 開 |
| `prefix.hope03` | 好事馬上就要發生的來賓 | any | 開 |
| `prefix.hope04` | 美味正在向您招手的來賓 | food | 開 |
| `prefix.hope05` | 好料已經在等您的來賓 | food | 開 |
| `prefix.hope06` | 被美食選中的來賓 | food | 開 |
| `prefix.hope07` | 準備好好享受的來賓 | any | 開 |
| `prefix.hope08` | 帶著好心情來的來賓 | any | 開 |
| `prefix.hope09` | 就是在等這一刻的來賓 | any | 開 |
| `prefix.hope10` | 今天運氣特別好的 | any | 開 |
| `prefix.hope11` | 期待到心花怒放的 | any | 開 |

**溫馨系**（`warm`，12 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.warm01` | 我們滿心歡迎的來賓 | any | 開 |
| `prefix.warm02` | 謝謝您選擇我們的來賓 | any | 開 |
| `prefix.warm03` | 一路辛苦趕來的來賓 | any | 開 |
| `prefix.warm04` | 辛苦了一整天的來賓 | any | 開 |
| `prefix.warm05` | 讓今天變得更美好的來賓 | any | 開 |
| `prefix.warm06` | 我們最想好好招待的來賓 | any | 開 |
| `prefix.warm07` | 帶著笑容來的來賓 | any | 開 |
| `prefix.warm08` | 今天的特別貴賓 | any | 開 |
| `prefix.warm09` | 我們一直在等的來賓 | any | 開 |
| `prefix.warm10` | 值得被好好疼愛的來賓 | any | 開 |
| `prefix.bday01` | 今天過生日的壽星來賓 | any | 手動 |
| `prefix.bday02` | 生日快樂的壽星 | any | 手動 |

**季節節慶系**（`festival`，13 句）

| key | 前綴 | venue | 預設 |
|---|---|---|---|
| `prefix.weather01` | 頂著大太陽趕來的來賓 | any | 關 |
| `prefix.weather02` | 冒著寒風來暖暖胃的來賓 | food | 關 |
| `prefix.weather03` | 下雨天也要來吃好料的來賓 | food | 關 |
| `prefix.weather04` | 熱到需要好好消暑的來賓 | any | 關 |
| `prefix.fest01` | 新年第一餐就交給我們的來賓 | food | 關 |
| `prefix.fest02` | 過年來吃團圓飯的來賓 | food | 關 |
| `prefix.fest03` | 情人節來甜蜜一下的來賓 | any | 關 |
| `prefix.fest04` | 母親節帶家人來團聚的來賓 | any | 關 |
| `prefix.fest05` | 端午節來吃飽飽的來賓 | food | 關 |
| `prefix.fest06` | 中秋節來團圓的來賓 | any | 關 |
| `prefix.fest07` | 聖誕節來跟我們一起過的來賓 | any | 關 |
| `prefix.fest08` | 週末來犒賞自己的來賓 | any | 關 |
| `prefix.fest09` | 下班來犒賞自己的來賓 | any | 關 |


- `venue: "food"` 的句子只適合餐飲（非餐飲門店後台應自動隱藏）。
- `defaultEnabled: false`：季節節慶系預設關閉，由門店當季／當天開；生日（`manualOnly`）只能由人員對單一號碼手動指定，不進隨機池。
- 原則：不拿外貌、身材、性別、年齡開玩笑；不假設顧客幾個人來、是不是熟客。

## 句型範本（`templates`）

| key | 名稱 | 步驟 |
|---|---|---|
| `tpl.counter` | 趣味版（櫃台） | 叮咚 → 前綴 → 號碼 → 請到 N 號櫃台 |
| `tpl.seat` | 趣味版（入座） | 叮咚 → 前綴 → 號碼 → 請準備入座 |
| `tpl.standard` | 標準版 | 叮咚 → 來賓 → 號碼 → 請到 N 號櫃台 |
| `tpl.recall` | 重叫版 | 叮咚 → 再叫一次～／再提醒一次喔～ → 前綴 → 號碼 → 櫃台 |
| `tpl.skipped` | 過號提醒版 | 叮咚 → 來賓 → 號碼 → 已經過號囉，請洽櫃台人員，我們會盡快幫您安排 |

另備 `phrase.seat2`（您的座位準備好囉，請跟著服務人員入座）、`phrase.desk`（請到櫃台辦理）可換進範本。

停頓（`gapsMs`）：叮咚後 250、前綴→號碼 60、字母→號碼 30、號碼→結尾 220、重叫語→前綴 160、重複播報之間 900。
片段本身已去頭尾靜音（頭留 20 ms、尾留 40 ms＋淡出），所以這裡的數字就是實際聽到的停頓。

前綴選取：依門店 `funProbability`（建議 0.7）決定這次用趣味前綴或「來賓」；從啟用清單隨機、避開上一次用過的；同一號碼唸 N 次沿用同一前綴。

## 叮咚（ffmpeg 純合成，無外部素材）

| key | 說明 | 長度 |
|---|---|---|
| `chime.dingdong` | 經典叮咚 E5→C5 | 1.9 s |
| `chime.bright` | 輕快三音 C5→E5→G5 | 1.4 s |
| `chime.bell` | 柔和鐘聲 D5、A4 兩擊（鐘的非整數倍泛音） | 2.6 s |

峰值統一 -4 dBFS，比語音略低。

## Demo（每個主題包一支）

`demo/demo-standard.mp3`、`demo-hungry.mp3`、`demo-waited.mp3`、`demo-anticipation.mp3`、`demo-warm.mp3`、`demo-festival.mp3`。
由 `gen-audio.py` 依 manifest 同一套拼接規則組出來，等於面板實際播放效果的預覽。

## 數量與大小

| 類別 | 檔數 | 大小 |
|---|---|---|
| chime | 3 | 0.0 MB |
| prefix | 56 | 0.4 MB |
| number | 7019 | 38.2 MB |
| phrase | 36 | 0.2 MB |
| **合計** | **7114** | **38.9 MB** |

號碼類含：A～F 整段 5,994、純號碼 999、字母 26。另有 demo 6 支＋聲音比較 4 支（不進面板）。

## 重新產生

```bash
python3 scripts/gen-audio.py               # 增量：只重做 文字／聲音參數 有變的檔案
python3 scripts/gen-audio.py --only prefix  # 只做前綴（chime / prefix / phrase / number）
python3 scripts/gen-audio.py --demos-only   # 只重組 demo
python3 scripts/gen-audio.py --force        # 全部重做（約 1 小時）
```

- 需求：`ffmpeg`、`ffprobe`、`edge-tts`（BIBIAI 已用 pipx 裝在 `~/.local/bin`）。
- 增量判斷存在 `.gen-cache.json`（每檔的參數雜湊）。改 voice/rate/pitch 會讓全部檔案重做。
- edge-tts 偶發空回應，腳本每段重試 5 次（指數退避）；最後仍失敗會列出並以非 0 結束。
- 若 edge-tts 回 403：`PATH=$HOME/.local/bin:$PATH pipx upgrade edge-tts`（微軟改協議時舊版會被擋）。

## 面板端快取策略（建議）

1. **檔案不可變**：上傳 R2 時路徑帶版本（例：`audio/v1/...`），回應 `Cache-Control: public, max-age=31536000, immutable`；改台詞就換版本號，面板比對 `manifest.version` 後重抓有變的檔。
2. **開機預載**（Service Worker → Cache Storage）：manifest、叮咚 3 段、已啟用前綴、phrase、本店用到的櫃台、本店字首的 1～300 號（每字首約 1.5 MB）。
3. **按需預取**：面板經 WS 收到「新取號」事件時就先抓那一號的音檔，叫號時一定已在快取；超過 300 號的也這樣補。
4. **解碼後留在記憶體**：`decodeAudioData` 的 AudioBuffer 用 LRU（約 200 段）；用 `AudioBufferSourceNode.start(t)` 依 `gapsMs` 精準排程，不用 `<audio>` 串接（會有不定延遲）。
5. **缺檔後備**：任一片段抓不到就整句改用 `speechSynthesis`，不要播一半。

## 尚未做 / 風險

- 未在實際店內電視、嘈雜環境試聽；語速與音量要現場再調（改 `audio-lines.json` 重跑即可）。
- edge-tts 是微軟 Edge 線上服務的非官方介面，**商用授權條款需業主自行確認**；素材一旦產出即可離線使用，但重生依賴該服務。
- MP3 解碼的編碼器延遲（約 25 ms）已被片段間停頓吸收，實機若覺得黏或空再調 `gapsMs`。

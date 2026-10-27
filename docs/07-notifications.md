# 07 — 通知（只用 Web）

不做 LINE、不做簡訊。手機號碼只供店員聯繫與辨識，**系統不會發簡訊**。

## 1. 三條通知路徑

| 對象 | 情境 | 路徑 |
|---|---|---|
| 叫號面板 | 一律 | WS `ticket.called` → **叮咚 → 語音唸號 ×N → 廣告恢復**（見 05-apps §1）。叫號機以 Android 包裝 App／kiosk 執行，**免點擊即可出聲**（ADR-027）。app 模式（UA 含 `QueueDisplayApp/`）完全不顯示「啟用聲音」提示；web 模式才顯示，且接受遙控器 OK／鍵盤任一鍵（Esc 除外）／點擊。音訊被擋時一律回報後台警示 |
| 顧客（頁面在前景） | 頁面開著 | WS `ticket.called` / `queue.position` → 全螢幕提醒＋響鈴＋震動（Android） |
| 顧客（頁面在背景／已關閉） | 已訂閱推播 | DO → `q-push` → consumer → Web Push（VAPID） |

觸發推播的時點（只在顧客**沒有開著 WS** 時才發，DO 以 `getWebSockets("ticket:<id>")` 判斷）：

1. 前面剩 **3 位**（門店可設 1～5）：「快輪到您了，A023 前面還有 3 位」
2. **叫到號**：「A023 請到 2 號櫃台」（`requireInteraction: true`、`renotify: true`）
3. 重叫：同 2
4. 過號：「A023 已過號，請洽櫃台」

## 2. 「開啟提醒並取號」按鈕（一次點擊做三件事）

```
點擊（user gesture）
 ├ 1. new AudioContext() / resume()，播放 0.1 秒靜音 → 解鎖之後的響鈴
 ├ 2. Notification.requestPermission()
 │     └ granted → serviceWorker.pushManager.subscribe({ applicationServerKey: VAPID_PUBLIC })
 └ 3. 送出取號；若拿到 subscription，取號成功後 POST /api/tickets/<id>/push
```

- 權限被拒或不支援：照常取號，號碼頁顯示「請保持此頁開啟以接收提醒」。
- 不在頁面載入時就請求權限（瀏覽器會降權，且體驗差）。

## 3. iOS 限制與 UX 對策

| 事實 | 對策 |
|---|---|
| iOS Safari 只有「加入主畫面」的 web app（iOS 16.4+）才能收 Web Push | 偵測 iOS 且 `!navigator.standalone` → 號碼頁顯示圖解「分享 → 加入主畫面」；加入後開啟會帶回號碼頁（ticket token 存在 localStorage，與 Safari **不共用**→ 以 URL 帶一次性代碼轉交） |
| iOS 不支援 `navigator.vibrate` | 以聲音＋畫面閃爍代替 |
| 未加入主畫面者無背景推播 | 號碼頁大字提示「**請保持此頁開啟**」；頁面開著時 WS 響鈴可靠 |
| 鎖屏後頁面會被凍結 | 號碼頁提示「請勿鎖定螢幕」；可嘗試 Screen Wake Lock API（iOS 支援版本**未查證**，不可用時不影響其他功能） |

- iOS 主畫面轉交：號碼頁「加入主畫面」教學旁顯示 4 位數轉交碼；主畫面 app 開啟時若無 ticket，顯示輸入框輸入轉交碼取回號碼
  （轉交碼 = ticket token 的短期兌換碼，10 分鐘）。
- Web App Manifest：`display: standalone`、`start_url: /resume`。

## 4. Web Push 實作規格（Worker／Queue consumer）

- VAPID：ES256（P-256）。公鑰在前端 `applicationServerKey`；私鑰 `VAPID_PRIVATE_KEY`（Worker secret）。
  JWT claims：`aud` = push endpoint 的 origin、`exp` ≤ 12 小時、`sub` = `mailto:` 平台聯絡信箱。
- Payload 加密：RFC 8291（`aes128gcm`）——ECDH（P-256）＋ HKDF＋AES-128-GCM，全部用 WebCrypto 完成，不引入 Node 套件。
- Payload ≤ 4 KB：`{t:"called", n:"A023", c:2, url:"/t/<id>"}`，文字由 Service Worker 組。
- `TTL`：叫號 120 秒、即將輪到 300 秒；`Urgency: high`。
- 回應 404 / 410 → 刪除該訂閱；429 / 5xx → `message.retry({delaySeconds})`，最多 3 次。
- consumer 一次 batch 最多 25 則並行送出。

## 5. 為何 DO 不直接送推播

DO 內 `await fetch(push service)` 期間 DO 持續計 wall-clock duration，且外部服務變慢會拖住整店的叫號處理。
放進 Queue：DO 只做一次 `send()`（快、在 Cloudflare 內部），重試也由 Queue 處理。成本見 02-cost-model §4。

## 6. 推播訂閱的生命週期

- 建立：取號後 `POST /api/tickets/<id>/push` → D1 `push_subscriptions`（`ticket_id` 為主鍵，一號一筆）。
- 刪除：號碼進終態 → q-history consumer 批次刪除；Cron 每日清 `created_at < now - 24h`。
- 不保存任何跨號碼的訂閱（下一次取號重新訂閱，權限已授予時不會再跳提示）。

## 7. 語音叫號素材（ADR-003，業主定案：預錄 edge-tts，不做即時語音）

素材與清單由 `assets/audio/` 及 `assets/audio/manifest.json` 提供（產生腳本 `scripts/gen-audio.*`，另案維護，本文件不規定其內部格式；
以下為面板端對 manifest 的**使用契約**，實作時以實際 manifest 欄位為準）。

| 項目 | 規格 |
|---|---|
| 風格 | 親切俏皮的叫號口吻（參考海底撈式叫號風格），**台詞原創** |
| 組成 | 叮咚音效 → 叫號句（拼接：**原創俏皮前綴**〔例「等到肚子餓的來賓」，或標準版「來賓」〕、字首、號碼、引導語、櫃台號）→ 可選的**趣味穿插語句** |
| 前綴選擇 | 依門店設定的主題包 tag／單句勾選與出現機率隨機挑選；可整個切成標準版（ADR-025） |
| 產生 | 一次性以 edge-tts 預錄，放 `assets/audio/` |
| 部署 | 建置 `apps/display` 時把 `assets/audio/` 複製到 `public/audio/`，**隨 Pages 靜態部署**（不放 R2，ADR-026）；檔名含版本目錄或 hash，可設長期快取 |
| 播放 | 面板依 `manifest.json` 找出各片段 → Web Audio API `decodeAudioData` 預載 → 叫號時依序 `start(t)` 排程無縫拼接 |
| 趣味穿插 | 門店後台設定「開／關」與「頻率」（例如每 N 次叫號插一次、或機率 %）；只插在叫號句之後、不插在號碼中間；重叫不插 |
| 叮咚 | manifest 內的多款叮咚，門店後台選擇 |
| 快取 | Service Worker **漸進快取**（見下），完成後斷網可唸；manifest 版本變更時只補抓差異檔 |
| 最後備援 | **僅在**素材缺檔或解碼失敗時 → `speechSynthesis`（`lang: zh-TW`）唸基本句型；並在面板角落顯示「語音素材不完整」提醒店長 |

### 語音包漸進快取（面板首次載入）

約 7,019 檔、約 50 MB，不能讓面板開機後等全部下載完才能叫號：

| 順序 | 內容 | 時機 |
|---|---|---|
| 1 | `manifest.json`、全部叮咚、句型片段（引導語、櫃台號、「來賓」）、門店已啟用主題包的前綴 | Service Worker `install` 階段，完成前面板顯示「語音準備中」但照常顯示號碼與 QR |
| 2 | 號碼片段：依門店今日已取號範圍（DO snapshot 的各類別最大號）往後 +100 | 開機後立即，背景下載 |
| 3 | 其餘號碼、未啟用的主題包、趣味穿插句 | 閒置時背景下載（`requestIdleCallback`，限制同時 4 個請求，叫號播放時暫停下載） |

- 叫號時若某片段尚未快取：直接從網路抓（同一份 Pages 靜態檔）；離線且缺檔才走 `speechSynthesis` 最後備援。
- 快取以 manifest 版本為鍵；新版本只下載 hash 變更的檔，舊版本檔在新版完整後刪除。

> 風險註記：edge-tts 使用 Microsoft Edge 線上朗讀服務的非官方介面，**商用授權條款未查證**。由於素材為一次性預錄，
> 若日後需更換，只需重新產生素材並更新 manifest 版本，面板程式不受影響。

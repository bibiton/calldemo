# 10 — 業主佈署教學（非工程師版）

> ⚠️ `scripts/` 裡的部署腳本是**草稿、尚未對 Cloudflare 實測**。這份教學先寫好流程，等 roadmap M6 完成後照著做即可。
> 每一步都寫了「要做什麼／預期看到什麼／出錯怎麼辦」。卡住時把畫面截圖給工程師（**不要截到 token**）。
>
> **只有一個環境：正式（production）**（ADR-049：DEMO 用途、成本最低）。沒有 staging，流程是：
> 本機測試全過 → 一鍵部署到正式環境 → **部署後在正式網址驗證**（自動 smoke＋手機／電視實機）。
> 網域 `jjoy.ai` 在**共用的 Cloudflare 帳號**（同帳號還有 noah、ecshop、pos、reserve 等產品）：本系統所有東西都叫 `call-…`，
> 腳本會拒絕碰任何不是 `call-` 開頭的資源。

## 全部流程一覽

```
A. 準備（只做一次）      1 確認帳號與網域 → 2 確認 Workers Paid → 3 啟用 Zero Trust → 4 API Token → 5 裝工具 → 6 下載程式
B. 首次建置（只做一次）  7 填憑證檔 cf.env → 8 本機測試 → 9 bootstrap → 10 檢查網域與媒體 → 11 檢查 Access
C. 部署後驗證           12 在正式網址逐一驗證（含媒體、手機、電視）
D. 日常                 13 更新（本機測試 → 一行部署）→ 14 回滾 → 15 看夜間成本
```

本系統的網址（全部在 `jjoy.ai` 底下）：

| 網址 | 用途 |
|---|---|
| `https://call-admin.jjoy.ai` | 總後台（Cloudflare Access 保護） |
| `https://call-store.jjoy.ai` | 門店後台 |
| `https://call-staff.jjoy.ai` | 人員端（櫃台叫號） |
| `https://call-display.jjoy.ai` | 叫號面板（電視） |
| `https://call-q.jjoy.ai` | 顧客取號（掃面板 QR 進入） |
| `https://call-api.jjoy.ai` | API（程式用） |
| `https://call-media.jjoy.ai` | 廣告與 Logo 檔案 |

---

## A. 準備

### 步驟 1：確認 Cloudflare 帳號與網域
- **要做什麼**：用有權限的帳號登入 https://dash.cloudflare.com → 選放 `jjoy.ai` 的那個帳號 → Websites 裡點 `jjoy.ai`。
- **預期看到**：`jjoy.ai` 狀態 **Active**。右側 API 區塊可以看到 **Zone ID** 與 **Account ID**，記下來（步驟 7 用）。
- **出錯怎麼辦**：看不到 `jjoy.ai` → 你登入的帳號不是共用帳號，或沒有被加為成員，請帳號管理者邀請你。
- **注意**：DNS 頁裡 noah、ecshop、pos、reserve 等紀錄是其他產品的，**不要動**。本系統只會新增 `call-` 開頭的紀錄。

### 步驟 2：確認 Workers Paid（每月 $5 美元）
- **要做什麼**：Workers & Pages → Plans。
- **預期看到**：已是 **Workers Paid**（共用帳號上其他產品多半已升級，就不用再做）。若還是 Free → 選 Workers Paid → 綁信用卡。
- **為什麼要**：叫號核心（Durable Objects 的 SQLite）與 Queues 需要 Paid 方案。帳號只付一次 $5，不會因為多一個產品重複收。
- **出錯怎麼辦**：信用卡被拒 → 換卡或聯絡發卡銀行開放海外交易。

### 步驟 3：啟用 Zero Trust（免費，給總後台登入用）
- **要做什麼**：主控台左側 **Zero Trust**。若已啟用（共用帳號可能已有）就略過；第一次會要你取一個 team 名稱、選 **Free** 方案（50 人以內免費）。
- **預期看到**：Zero Trust 首頁；Settings → Custom Pages 可看到 team domain（`<team>.cloudflareaccess.com`）。
- **出錯怎麼辦**：要求綁卡 → Free 方案也可能要求付款方式驗證，綁了不會扣款。

### 步驟 4：建立 API Token（給部署腳本用）
- **要做什麼**：右上角頭像 → My Profile → API Tokens → Create Token → **Create Custom Token**，名稱填 `call-deploy`，依下表勾選：

| 第一欄 | 第二欄 | 第三欄 |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Queues | Edit |
| Account | Cloudflare Pages | Edit |
| Account | Account Settings | Read |
| Account | Access: Apps and Policies | Edit（選填：讓腳本自動設定總後台登入） |
| Account | Access: Organizations, Identity Providers, and Groups | Edit（選填：同上，畫面名稱以實際為準） |
| Zone | Workers Routes | Edit |
| Zone | DNS | Edit |

  - Account Resources：只選放 `jjoy.ai` 的帳號；Zone Resources：Specific zone → **只選 `jjoy.ai`**。
  - （「Edit」在官方文件稱為「Write」，畫面顯示哪個就選哪個。）
  - 按 Continue → Create Token → **複製 Token 直接貼進步驟 7 的檔案**（只會顯示一次；不要貼到聊天或截圖）。
- **預期看到**：Token 列表多一筆 `call-deploy`，狀態 Active。
- **出錯怎麼辦**：忘了複製 → 刪掉重建即可。之後部署出現 `Authentication error [code: 10000]` → 多半是少勾權限，對照上表補。
- 用量計量（總後台「用量與成本」頁）需要另一支**唯讀** token：權限只勾 Account → Account Analytics → Read，名稱 `call-analytics-read`，貼到步驟 7 的 `AE_API_TOKEN`（選填，之後再補也可以）。

### 步驟 5：在電腦安裝工具
- **要做什麼**（Windows 建議用 WSL；Mac 用「終端機」）：
  1. 安裝 Node.js 22 LTS：https://nodejs.org → 下載 LTS 安裝。
  2. 打開終端機輸入：
     ```bash
     corepack enable
     corepack prepare pnpm@latest --activate
     ```
  3. 另外需要 `git`、`jq`、`openssl`、`curl`（Mac：`brew install git jq openssl`；Ubuntu／WSL：`sudo apt install git jq openssl curl`）。
  4. wrangler 不用另外裝（步驟 6 的 `pnpm install` 會裝好專案指定的版本）。**不要執行 `wrangler login`**——部署腳本只用步驟 7 的 token。
- **預期看到**：輸入 `node -v` 顯示 `v22.x`；`pnpm -v` 有版本號。
- **出錯怎麼辦**：`command not found` → 關掉終端機重開再試；仍不行把錯誤訊息截圖給工程師。

### 步驟 6：下載程式
- **要做什麼**：
  ```bash
  git clone <repo 網址> queue-call-system
  cd queue-call-system
  pnpm install
  pnpm exec playwright install chromium     # 步驟 8 的畫面測試要用
  ```
- **預期看到**：最後一行類似 `Done in 30s`，沒有紅色 `ERR`。
- **出錯怎麼辦**：`Permission denied (publickey)` → 你的 GitHub 帳號還沒有這個 repo 的權限，請工程師加。

---

## B. 首次建置

### 步驟 7：填憑證檔 `cf.env`
- **要做什麼**：
  ```bash
  mkdir -p ~/.config/queue-call-system
  cp scripts/config.example.env ~/.config/queue-call-system/cf.env
  chmod 600 ~/.config/queue-call-system/cf.env
  ```
  用文字編輯器打開 `~/.config/queue-call-system/cf.env`，填入：
  - `CLOUDFLARE_API_TOKEN`：步驟 4 的 token
  - `CLOUDFLARE_ACCOUNT_ID`、`CF_ZONE_ID`：步驟 1 記下的 Account ID、Zone ID
  - `ACCESS_ALLOWED_EMAILS`：可以登入總後台的主管 email，逗號分隔。**還沒決定可以先留空**，之後填上再跑一次步驟 9 即可。
- **預期看到**：存檔即可。這個檔案不在專案資料夾裡，不會被上傳到 GitHub。
- **出錯怎麼辦**：腳本說「權限過寬」→ 再執行一次 `chmod 600 ~/.config/queue-call-system/cf.env`。
  **不要**把這個檔的內容貼給任何人；工程師協助時只需要知道「哪個變數沒填」。

### 步驟 8：本機測試（部署前的關卡）
- **要做什麼**：
  ```bash
  pnpm test      # 全部自動測試
  pnpm e2e       # 畫面流程測試（約數分鐘，截圖在 test-results/visual/）
  ```
  想自己先看畫面：`pnpm dev`，再依 README「本機開發」打開 http://localhost:5172 等網址。
- **預期看到**：兩個指令最後都沒有 `failed`。
- **出錯怎麼辦**：有失敗就**不要部署**，把輸出給工程師。

### 步驟 9：執行首次建置（bootstrap）
- **要做什麼**：
  ```bash
  bash scripts/bootstrap.sh
  ```
- **預期看到**：一步步顯示 `✔ Cloudflare token 驗證通過`、`✔ D1 call-db-production 已建立`（或 `已存在，略過`）、KV、R2（含 CORS 與 `call-media.jjoy.ai`）、Queues、
  Pages 專案、資料庫建表、第一次部署、secrets、網域、Access，最後顯示 `bootstrap 完成` 與網址。
  以 `•` 開頭、寫「請手動…」的行是**提示**，照步驟 10、11 補做即可。
- **可以重複執行**：中途失敗修好後直接再跑一次，已建好的會自動略過，**不會**重設金鑰。
- **出錯怎麼辦**：
  - `安全閘：拒絕操作…` → 有東西的名稱不是 `call-` 開頭，腳本為了保護同帳號其他產品而停下。截圖給工程師，不要自己改名。
  - `token 無效或無法存取` → 步驟 4、7：token 貼錯或 Account ID 不對。
  - `You need a Workers Paid plan` → 回步驟 2。
  - 任何紅色錯誤 → 整段終端機輸出複製給工程師（輸出裡不含 token）。

### 步驟 10：檢查網域與媒體（腳本沒自動完成時才手動）
- **要做什麼**：看步驟 9 的輸出。有「請手動綁定」的提示才做：
  1. Workers & Pages → `call-admin-production` → Custom domains → Set up a custom domain → `call-admin.jjoy.ai`。
     同樣：`call-store-production`→`call-store.jjoy.ai`、`call-staff-production`→`call-staff.jjoy.ai`、
     `call-display-production`→`call-display.jjoy.ai`、`call-q-production`→`call-q.jjoy.ai`。
  2. R2 → `call-media-production` → Settings → Custom Domains → Add → `call-media.jjoy.ai`。
     同一頁的 **Public Development URL（r2.dev）保持 Disabled**，不要開。
  3. R2 → `call-media-production` → Settings → CORS Policy → 允許 Origins：`https://call-display.jjoy.ai`、`https://call-store.jjoy.ai`、
     `https://call-admin.jjoy.ai`、`https://call-q.jjoy.ai`；Methods：`GET`、`HEAD`。
  4. **長期快取規則（一定要手動做一次）**：Websites → `jjoy.ai` → Caching → Cache Rules → Create rule：
     名稱 `call-media long cache`；條件 Hostname equals `call-media.jjoy.ai`；Cache eligibility 選 **Eligible for cache**；
     Edge TTL 選「Use cache-control header if present」；Browser TTL 選「Respect origin」→ Deploy。
     （腳本刻意不做：自動寫入會影響同網域其他產品的快取規則。廣告檔名含內容指紋，換內容就換檔名，所以可以快取一年。）
  （`call-api.jjoy.ai` 由部署自動處理，不用手動。）
- **預期看到**：每個網域狀態幾分鐘內從 Initializing 變 **Active**。
- **出錯怎麼辦**：卡在 Initializing 超過 30 分鐘 → DNS 頁看該 `call-` 子網域是否有舊紀錄衝突（**只刪 `call-` 開頭的**）後重試。

### 步驟 11：檢查總後台的 Cloudflare Access
- **要做什麼**：腳本有權限時會自動設定；若提示「請手動設定 Access」，到 Zero Trust → Access → Applications → Add an application → Self-hosted：
  1. Application name：`call-admin`
  2. Domain：`call-admin.jjoy.ai`（Path 留空＝整個網站，包含 `/api/`）
  3. Policy：名稱 `call-admin-allow`，Action = Allow，Include → Emails → 填 `ACCESS_ALLOWED_EMAILS` 的每個 email
  4. Login methods：**One-time PIN**（用 email 收 6 位數驗證碼登入，不需要其他帳號系統）
  5. 存檔後在 Application 的 Overview 複製 **Application Audience (AUD) Tag**，和 team domain（`<team>.cloudflareaccess.com`）
     一起填進 cf.env 的 `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`，再跑一次 `bash scripts/bootstrap.sh`（會同步成 Worker secrets）。
- 名單要增減：改 cf.env 的 `ACCESS_ALLOWED_EMAILS` → 跑 `bash scripts/bootstrap.sh`（同時更新 Access policy 與 Worker 的名單）。
- **預期看到**：用無痕視窗開 `https://call-admin.jjoy.ai` → 先看到 Cloudflare 登入頁 → 輸入允許的 email → 收信拿 6 位數驗證碼 → 進入總後台。
- **出錯怎麼辦**：輸入 email 後顯示「無權限」→ policy 的 email 打錯；進得去但後台顯示 401 → AUD tag 沒設或設錯，或該 email 不在 cf.env 的名單裡（Worker 會再比一次）。

---

## C. 部署後在正式網址驗證（步驟 12）

bootstrap／deploy 最後會自動跑 smoke test（API 健康檢查、5 個網址可開、總後台受保護）。通過後，**一定要再用真的手機與電視**依序檢查，看到描述的畫面就算成功：

| 網址／動作 | 預期看到 |
|---|---|
| `https://call-api.jjoy.ai/health` | 一行文字 `{"ok":true,"version":"..."}` |
| `https://call-admin.jjoy.ai` | Access 登入 → 總後台門店列表（smoke 測試店不顯示，初始為空） |
| 在總後台建一家測試門店 → 手機登入 `https://call-store.jjoy.ai` | 門店後台即時隊列頁 |
| 門店後台上傳一張廣告圖 | 上傳成功；廣告列表有縮圖 |
| 在電視（或電腦瀏覽器）開 `https://call-display.jjoy.ai` | 顯示 6 位數配對碼 → 在門店後台「裝置」輸入 → 面板出現門店名稱、QR、廣告與「請點一下畫面啟用聲音」→ 點一下聽到叮咚 |
| 手機掃面板上的 QR | 開到 `https://call-q.jjoy.ai/s/…` 顧客取號頁 → 選服務 → 填姓名手機 → 取號成功顯示號碼 |
| （正式叫號機）電視盒安裝叫號機 App（APK）→ 配對 → 拔插電源 | 不碰任何按鈕，開機後自動進入面板；叫號時直接出聲（不會出現「請點一下」）。若出現「請點一下畫面啟用聲音」代表不是用 App 開的，門店後台也會顯示「無法出聲」警示 |
| 另一支手機開 `https://call-staff.jjoy.ai` | 人員登入 → 按「叫下一號」→ 面板 1 秒內出現該號並唸出、顧客手機響鈴 |
| iPhone：顧客頁「加入主畫面」後再取號、鎖螢幕 | 叫號時收到推播通知 |

**媒體（廣告檔）檢查**（工程師或熟悉終端機的人做；`<廣告網址>` 可在電腦瀏覽器開面板、按 F12 → Network 篩選 `call-media` 取得，形如 `https://call-media.jjoy.ai/ads/<…>/<64 位英數>.jpg`）：

1. 瀏覽器直接開 `<廣告網址>` → 看得到圖片或影片。
2. 看標頭：
   ```bash
   curl -sI <廣告網址>
   ```
   預期有 `cache-control: public, max-age=31536000, immutable`；連續執行兩次，第二次 `cf-cache-status: HIT`（有 Cache Rule 才會 HIT）。
3. 看 CORS（模擬面板來源）：
   ```bash
   curl -sI -H "Origin: https://call-display.jjoy.ai" <廣告網址> | grep -i access-control-allow-origin
   ```
   預期 `access-control-allow-origin: https://call-display.jjoy.ai`。把 Origin 換成 `https://example.org` 則**不應**出現這行。
4. 確認 r2.dev 沒開：R2 → `call-media-production` → Settings → Public Development URL 顯示 **Disabled**。

全部通過＝上線成功。有任何一項不對，先看步驟 14 回滾，再把畫面給工程師。

---

## D. 日常

### 步驟 13：更新版本（本機測試 → 一行部署）
- **要做什麼**：
  ```bash
  git pull
  pnpm install
  bash scripts/deploy.sh
  ```
  `deploy.sh` 會先自己跑 `pnpm test` 與 `pnpm e2e`，**任何一項失敗就不會動到正式環境**。
- **預期看到**：最後顯示 `✔ smoke test 通過，部署完成`。接著照步驟 12 的表在正式網址抽查（至少：取號 → 叫號 → 面板唸號）。
- **出錯怎麼辦**：顯示 `smoke test 失敗，已自動回滾 Worker 到 <版本>` → API 已回到上一版；把輸出給工程師。
- 沒有自動部署：合併程式不會自己上線，一定是有人執行這個指令才會更新。

### 步驟 14：出事時回滾
- **要做什麼**：
  ```bash
  bash scripts/rollback.sh       # 回到上一版
  ```
  前端畫面有問題時：主控台 → Workers & Pages → 該專案（例如 `call-display-production`）→ Deployments → 選上一個綠色的 → **Rollback**。
- **預期看到**：`✔ Worker call-api-production 已回滾`；重新整理網頁恢復正常。
- **注意**：資料庫不會跟著回滾（設計上新版只會「加」欄位，舊版照樣能用）。資料本身出錯請找工程師用 Time Travel 還原。

### 步驟 15：確認夜間成本接近 0
- **要做什麼**：主控台 → Workers & Pages → `call-api-production` → 上方 **Durable Objects**（或 Metrics）→ 找 **Duration** 圖，時間範圍選「過去 24 小時」或「7 天」。
- **預期看到**：營業時間有起伏，**打烊後到開店前幾乎是平的、貼近 0**。總後台「用量與成本」頁沒有「夜間 DO 未休眠」警示。
- **出錯怎麼辦**：夜間也一直往上爬 → 代表有門店的程式沒進入休眠，會多花錢。截圖給工程師，並在總後台看哪家店有警示。
- 另外每月可在主控台 → Manage Account → Billing 看實際帳單（共用帳號的帳單包含其他產品），在總後台「帳單分攤」輸入本系統相關金額，就能看到每家店的實際成本。

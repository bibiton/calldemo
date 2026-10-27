# 10 — 業主佈署教學（非工程師版）

> ⚠️ 目前程式碼尚未完成，`scripts/` 裡的腳本是**草稿、未實測**。這份教學先寫好流程，等 roadmap M6 完成後照著做即可。
> 每一步都寫了「要做什麼／預期看到什麼／出錯怎麼辦」。卡住時把畫面截圖給工程師。

## 全部流程一覽

```
A. 準備（只做一次）  1 Cloudflare 帳號 → 2 網域 → 3 升級 Workers Paid → 4 API Token → 5 裝工具 → 6 下載程式
B. 首次建置（只做一次）  7 wrangler login → 8 填設定 → 9 bootstrap → 10 綁網域 → 11 開 Access
C. 驗證上線  12 逐一打開網址
D. 日常  13 更新（一行指令）→ 14 回滾 → 15 看夜間成本
```

---

## A. 準備

### 步驟 1：註冊 Cloudflare 帳號
- **要做什麼**：到 https://dash.cloudflare.com/sign-up 用公司信箱註冊，完成 email 驗證。
- **預期看到**：登入後看到 Cloudflare 主控台（左側有 Websites、Workers & Pages 等選單）。
- **出錯怎麼辦**：收不到驗證信 → 檢查垃圾郵件匣，或在登入頁按重寄。

### 步驟 2：把網域交給 Cloudflare 管理
- **要做什麼**：主控台 → Add a domain → 輸入網域（例如 `example.com`）→ 選 Free 方案 →
  依畫面指示到網域註冊商（例如 GoDaddy、PChome）把 **Nameserver** 改成 Cloudflare 給的兩組。
- **預期看到**：數小時內（最長 24 小時）網域狀態變成 **Active**，並收到 Cloudflare 通知信。
- **出錯怎麼辦**：一直 Pending → 回註冊商確認 nameserver 有改對、舊的已刪除。網域上若已有官網或 email，
  先讓工程師確認 DNS 紀錄都已匯入，避免中斷。

### 步驟 3：升級 Workers Paid（每月 $5 美元）
- **要做什麼**：主控台 → Workers & Pages → Plans → 選 **Workers Paid** → 綁信用卡。
- **預期看到**：Plans 頁顯示 Workers Paid（$5/month）。
- **為什麼要**：叫號核心（Durable Objects 的 SQLite）與 Queues 需要 Paid 方案。50 家店預估每月總共約 $5.6。
- **出錯怎麼辦**：信用卡被拒 → 換卡或聯絡發卡銀行開放海外交易。

### 步驟 4：建立 API Token（給自動部署用）
- **要做什麼**：右上角頭像 → My Profile → API Tokens → Create Token → **Create Custom Token**，依下表勾選：

| 第一欄 | 第二欄 | 第三欄 |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Queues | Edit |
| Account | Cloudflare Pages | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |
| Zone | DNS | Edit |

  - Account Resources：選你的帳號；Zone Resources：Specific zone → 選你的網域。
  - （「Edit」在官方文件稱為「Write」，畫面顯示哪個就選哪個。）
  - 按 Continue → Create Token → **複製 Token 存到密碼管理器**（只會顯示一次）。
  - 同一頁右側或主控台首頁網址列可以看到 **Account ID**，一併記下。
- **預期看到**：Token 列表多一筆，狀態 Active。
- **出錯怎麼辦**：忘了複製 → 刪掉重建即可。之後部署出現 `Authentication error [code: 10000]` → 多半是少勾權限，對照上表補。

### 步驟 5：在電腦安裝工具
- **要做什麼**（Windows 建議用 WSL；Mac 用「終端機」）：
  1. 安裝 Node.js 22 LTS：https://nodejs.org → 下載 LTS 安裝。
  2. 打開終端機輸入：
     ```bash
     corepack enable
     corepack prepare pnpm@latest --activate
     npm install -g wrangler
     ```
  3. 另外需要 `git`、`jq`、`openssl`（Mac：`brew install git jq openssl`；Ubuntu／WSL：`sudo apt install git jq openssl`）。
- **預期看到**：輸入 `node -v` 顯示 `v22.x`；`pnpm -v`、`wrangler -v` 都有版本號。
- **出錯怎麼辦**：`command not found` → 關掉終端機重開再試；仍不行把錯誤訊息截圖給工程師。

### 步驟 6：下載程式
- **要做什麼**：
  ```bash
  git clone <repo 網址> queue-call-system
  cd queue-call-system
  pnpm install
  ```
- **預期看到**：最後一行類似 `Done in 30s`，沒有紅色 `ERR`。
- **出錯怎麼辦**：`Permission denied (publickey)` → 你的 GitHub 帳號還沒有這個 repo 的權限，請工程師加。

---

## B. 首次建置

### 步驟 7：登入 wrangler
- **要做什麼**：`wrangler login` → 瀏覽器跳出授權頁 → 按 Allow。
- **預期看到**：終端機顯示 `Successfully logged in`；`wrangler whoami` 顯示你的 email 與 Account ID。
- **出錯怎麼辦**：瀏覽器沒跳出 → 複製終端機顯示的網址手動貼到瀏覽器。

### 步驟 8：填設定檔
- **要做什麼**：複製範本並用文字編輯器打開：
  ```bash
  cp scripts/config.example.env scripts/config.production.env
  ```
  填入：`DOMAIN=example.com`、`ADMIN_EMAILS=you@company.com`（總後台可登入的 email，逗號分隔）、`PUSH_CONTACT=mailto:you@company.com`。
  想先試水溫就同樣做一份 `config.staging.env`（會使用 `*.staging.example.com`）。
- **預期看到**：檔案存好即可。
- **出錯怎麼辦**：不確定填什麼 → 保持範本的說明文字，問工程師。

### 步驟 9：執行首次建置（bootstrap）
- **要做什麼**：
  ```bash
  bash scripts/bootstrap.sh staging        # 建議先做 staging
  bash scripts/bootstrap.sh production
  ```
- **預期看到**：一步步顯示 `✔ D1 qcs-db 已建立`（或 `已存在，略過`）、KV、R2、Queues、secrets、Pages 專案、資料庫建表、第一次部署，
  最後顯示 `bootstrap 完成` 與 5 個網址。
- **可以重複執行**：中途失敗修好後直接再跑一次，已建好的會自動略過，**不會**重設金鑰。
- **出錯怎麼辦**：
  - `You need a Workers Paid plan` → 回步驟 3。
  - `already exists` 但腳本中止 → 截圖給工程師（可能是同名資源由別人建立）。
  - 任何紅色錯誤 → 整段終端機輸出複製給工程師。

### 步驟 10：綁定網域
- **要做什麼**：bootstrap 有權限時會自動綁定；若最後提示「請手動綁定」，到主控台：
  1. Workers & Pages → 點 `qcs-admin` → Custom domains → Set up a custom domain → 輸入 `admin.example.com` → 確認。
  2. 同樣把 `qcs-store`→`store.`、`qcs-staff`→`staff.`、`qcs-display`→`display.`、`qcs-customer`→`q.`。
  3. R2 → `qcs-media` → Settings → Custom Domains → `media.example.com`。
  （`api.example.com` 由部署自動處理，不用手動。）
- **預期看到**：每個網域狀態幾分鐘內從 Initializing 變 **Active**。
- **出錯怎麼辦**：卡在 Initializing 超過 30 分鐘 → 確認步驟 2 網域是 Active，以及該子網域沒有舊的 DNS 紀錄衝突（DNS 頁刪掉同名舊紀錄後重試）。

### 步驟 11：用 Cloudflare Access 保護總後台
- **要做什麼**：主控台 → Zero Trust（第一次會要你取一個 team 名稱、選 **Free** 方案，免費 50 人）→ Access → Applications →
  Add an application → Self-hosted：
  1. Application name：`叫號總後台`
  2. Domain：`admin.example.com`；再加一筆 `api.example.com`，Path 填 `admin/*`
  3. Policy：Action = Allow，Include → Emails → 填平台管理員 email
  4. Login methods：One-time PIN
  5. 存檔後在 Application 的 Overview 複製 **Application Audience (AUD) Tag**，交給工程師（或執行
     `wrangler secret put ACCESS_AUD --env production` 貼上）。
- **預期看到**：用無痕視窗開 `https://admin.example.com` → 先看到 Cloudflare 登入頁 → 輸入允許的 email → 收信拿 6 位數驗證碼 → 進入總後台。
- **出錯怎麼辦**：輸入 email 後顯示「無權限」→ policy 的 email 打錯；進得去登入頁但後台顯示 401 → AUD tag 沒設或設錯。

---

## C. 驗證上線（步驟 12）

依序打開，看到描述的畫面就算成功：

| 網址 | 預期看到 |
|---|---|
| `https://api.example.com/health` | 一行文字 `{"ok":true,"version":"..."}` |
| `https://admin.example.com` | Access 登入 → 總後台門店列表（初始只有 smoke 測試店不顯示，列表為空） |
| 在總後台建一家測試門店 → 登入 `https://store.example.com` | 門店後台即時隊列頁 |
| 在電視（或電腦瀏覽器）開 `https://display.example.com` | 顯示 6 位數配對碼 → 在門店後台「裝置」輸入 → 面板出現門店名稱、QR 與「請點一下畫面啟用聲音」→ 點一下聽到叮咚 |
| 手機掃面板上的 QR | 顧客取號頁 → 選服務 → 填姓名手機 → 取號成功顯示號碼 |
| 另一支手機開 `https://staff.example.com` | 人員登入 → 按「叫下一號」→ 面板 1 秒內出現該號並唸出、顧客手機響鈴 |

全部通過＝上線成功。

---

## D. 日常

### 步驟 13：更新版本（一行指令）
- **要做什麼**：工程師合併到 `main` 後 GitHub 會**自動部署**，你什麼都不用做。若要手動：
  ```bash
  git pull && bash scripts/deploy.sh production
  ```
- **預期看到**：最後顯示 `✔ smoke test 通過，部署完成`。
- **出錯怎麼辦**：顯示 `smoke test 失敗，已自動回滾到 <版本>` → 系統已回到上一版，服務不受影響；把輸出給工程師。

### 步驟 14：出事時回滾
- **要做什麼**：
  ```bash
  bash scripts/rollback.sh production       # 回到上一版
  ```
  前端畫面有問題時：主控台 → Workers & Pages → 該專案 → Deployments → 選上一個綠色的 → **Rollback**。
- **預期看到**：`✔ 已回滾到 <版本>`；重新整理網頁恢復正常。
- **注意**：資料庫不會跟著回滾（設計上新版只會「加」欄位，舊版照樣能用）。資料本身出錯請找工程師用 Time Travel 還原。

### 步驟 15：確認夜間成本接近 0
- **要做什麼**：主控台 → Workers & Pages → `qcs-api` → 上方 **Durable Objects**（或 Metrics）→ 找 **Duration** 圖，時間範圍選「過去 24 小時」或「7 天」。
- **預期看到**：營業時間有起伏，**打烊後到開店前幾乎是平的、貼近 0**。總後台「用量與成本」頁沒有「夜間 DO 未休眠」警示。
- **出錯怎麼辦**：夜間也一直往上爬 → 代表有門店的程式沒進入休眠，會多花錢。截圖給工程師，並在總後台看哪家店有警示。
- 另外每月可在主控台 → Manage Account → Billing 看實際帳單，並在總後台「帳單分攤」輸入金額，就能看到每家店的實際成本。

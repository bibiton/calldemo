# 10 — 業主佈署教學（非工程師版）

> 這份教學已依 **2026-10-27 第一次實際部署**的指令與畫面輸出修正（`scripts/` 已在共用帳號實測：bootstrap 兩次、deploy、smoke、自動回滾、回滾演練）。
> 每一步都寫了「要做什麼／預期看到什麼／出錯怎麼辦」。卡住時把畫面截圖給工程師（**不要截到 token**）。
>
> **只有一個環境：正式（production）**（ADR-049：DEMO 用途、成本最低）。沒有 staging，流程是：
> 本機測試全過 → 一鍵部署到正式環境 → **部署後在正式網址驗證**（自動 smoke＋手機／電視實機）。
> 網域 `jjoy.ai` 在**共用的 Cloudflare 帳號**（同帳號還有 noah、ecshop、pos、reserve 等產品）：本系統所有東西都叫 `call-…`，
> 腳本會拒絕碰任何不是 `call-` 開頭的資源。
> 5 個網頁（總後台、門店後台、人員端、面板、顧客頁）是 5 個 **Worker**（名稱 `call-<名稱>-production`），**不是 Pages**（ADR-050：共用帳號的 Pages 名額已滿）。

## 全部流程一覽

```
A. 準備（只做一次）      1 確認帳號與網域 → 2 確認 Workers Paid → 3 啟用 Zero Trust → 4 API Token → 5 裝工具 → 6 下載程式
B. 首次建置（只做一次）  7 填憑證檔 cf.env → 8 本機測試 → 9 bootstrap（跑兩次）→ 10 快取規則（＋選用：啟用 Analytics Engine）→ 11 檢查 Access
C. 部署後驗證           12 灌 Demo 資料 → 自動 smoke／正式網址 E2E → 手機、電視實機
D. 日常                 13 更新（本機測試 → 一行部署）→ 14 回滾 → 15 看夜間成本
```

本系統的網址（全部在 `jjoy.ai` 底下；登入方式見 README「DEMO 網址與登入方式」）：

| 網址 | 用途 |
|---|---|
| `https://call-admin.jjoy.ai` | 總後台（Cloudflare Access 保護） |
| `https://call-store.jjoy.ai` | 門店後台 |
| `https://call-staff.jjoy.ai` | 人員端（櫃台叫號） |
| `https://call-display.jjoy.ai` | 叫號面板（電視） |
| `https://call-q.jjoy.ai` | 顧客取號（掃面板 QR 進入） |
| `https://call-api.jjoy.ai` | API（程式用；`/health` 可看版本） |
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
- **預期看到**：Zero Trust 首頁。team domain（`<team>.cloudflareaccess.com`）**不用抄**：bootstrap 會自己從登入頁網址讀到（步驟 9）。
- **出錯怎麼辦**：要求綁卡 → Free 方案也可能要求付款方式驗證，綁了不會扣款。

### 步驟 4：建立 API Token（給部署腳本用）
- **要做什麼**：右上角頭像 → My Profile → API Tokens → Create Token → **Create Custom Token**，名稱填 `call-deploy`，依下表勾選。
  這是 2026-10-27 實際部署成功時用的組合：

| 第一欄 | 第二欄 | 第三欄 | 說明 |
|---|---|---|---|
| Account | Workers Scripts | Edit | API 與 5 個網頁 |
| Account | D1 | Edit | 資料庫 |
| Account | Workers KV Storage | Edit | |
| Account | Workers R2 Storage | Edit | 廣告與 Logo |
| Account | Queues | Edit | |
| Account | Account Settings | Read | 腳本確認帳號 |
| Account | Access: Apps and Policies | Edit | 讓腳本自動設定總後台登入 |
| Zone | Workers Routes | Edit | |
| Zone | DNS | Edit | 自動建 `call-` 網域 |

  - Account Resources：只選放 `jjoy.ai` 的帳號；Zone Resources：Specific zone → **只選 `jjoy.ai`**。
  - （「Edit」在官方文件稱為「Write」，畫面顯示哪個就選哪個。）
  - **不需要**：Cloudflare Pages（已改用 Worker；舊 token 有勾也沒關係）。
  - **可不勾**：Access: Organizations, Identity Providers, and Groups——實際部署時沒有這項也完成了（腳本改從登入頁網址讀 team domain；email 驗證碼登入是預設就有的）。
  - 按 Continue → Create Token → **複製 Token 直接貼進步驟 7 的檔案**（只會顯示一次；不要貼到聊天或截圖）。
- **預期看到**：Token 列表多一筆 `call-deploy`，狀態 Active。
- **出錯怎麼辦**：忘了複製 → 刪掉重建即可。之後部署出現 `Authentication error [code: 10000]` → 多半是少勾權限，對照上表補。
- 用量計量（總後台「用量與成本」頁的 Analytics Engine 數字）需要另一支**唯讀** token：權限只勾 Account → Account Analytics → Read，名稱 `call-analytics-read`，
  貼到步驟 7 的 `AE_API_TOKEN`。**目前尚未提供**（帳號也還沒啟用 Analytics Engine，見步驟 10），之後再補即可。

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
  pnpm exec playwright install chromium     # 步驟 8、12 的畫面測試要用
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
- 同一個資料夾之後還會多出兩個檔（腳本自動產生，權限 600，**同樣不要外流**）：`smoke.json`（部署驗證用的測試店帳密）、`demo-output.json`（Demo 門店的密碼、PIN、已配對裝置網址，步驟 12）。

### 步驟 8：本機測試（部署前的關卡）
- **要做什麼**：
  ```bash
  pnpm test      # 全部自動測試
  pnpm e2e       # 畫面流程測試（約數分鐘，截圖在 test-results/visual/）
  ```
  想自己先看畫面：見 [11-local-testing](11-local-testing.md)「一鍵起全部」，再打開 http://localhost:5172 等網址。
- **預期看到**：兩個指令最後都沒有 `failed`。
- **出錯怎麼辦**：有失敗就**不要部署**，把輸出給工程師。

### 步驟 9：執行首次建置（bootstrap）——**要跑兩次**
- **要做什麼**：
  ```bash
  bash scripts/bootstrap.sh
  ```
  第一次跑完後，**再跑一次同一個指令**（理由見下方「為什麼要跑兩次」）。
- **預期看到**（第一次，依序）：
  1. `✔ Cloudflare token 驗證通過（未使用全域 wrangler login）`、`✔ wrangler.toml 的 production 資源名稱皆為 call- 前綴`
  2. **資源計畫清單**（還沒動任何東西，先列出來給你看）：
     ```
     • bootstrap 會建立或修改的 Cloudflare 資源（全部 call- 前綴；不刪除任何資源，不碰其他產品）：
         - call-api-production
         - call-db-production
         - call-license-production
         - call-media-production
         - call-history-production（以及 call-push-production 與兩個 -dlq- 佇列）
         - 前端 Worker call-admin-production → https://call-admin.jjoy.ai
           （store／staff／display／q 各一行）
         - Analytics Engine call_usage_production
         - Access 應用 call-admin（call-admin.jjoy.ai）
         - 網域 call-api.jjoy.ai（Worker）、call-admin.jjoy.ai/api/*（Worker route）、call-media.jjoy.ai（R2）
     ✔ 資源清單通過 call- 安全閘
     ```
  3. `✔ D1 call-db-production 已建立`、KV、R2（`✔ R2 CORS：…`、`✔ R2 自訂網域 call-media.jjoy.ai 已綁定`）、4 個 Queue、`✔ 5 個前端 Worker 設定檔通過 call- 安全閘`
  4. 資料庫建表、`✔ Worker call-api-production 已部署`、`✔ secret JWT_SECRET 已設定` 等金鑰
  5. 總後台登入（Access）：`✔ Access 應用 call-admin（call-admin.jjoy.ai）已建立`、`✔ Access policy call-admin-allow：Allow ACCESS_ALLOWED_EMAILS（N 人）`、`✔ secret ACCESS_AUD 已同步`
  6. `✔ smoke 店長帳密已產生：…/smoke.json`、`✔ 預設品牌、smoke 門店與店長、平台管理員已建立`
  7. 接著自動跑完整部署（步驟 13 的內容：測試 → 部署 API 與 5 個網頁 → smoke），最後 `✔ bootstrap 完成：https://call-admin.jjoy.ai …`
- **以 `•` 開頭的行是提示，不是錯誤**。實際部署時會看到這幾行，**都屬正常**：
  - `• 無法啟用 One-time PIN（…）`（2026-10-27 實際輸出；另一種可能是 `• 讀不到 Access 登入方式（…）`）：token 沒有那項權限。不用處理——Access 登入頁預設就有「用 email 收驗證碼」。
  - `• 讀不到 Access team domain：…`（第一次跑時會等約 1 分鐘才出現）：總後台網址要等最後的部署才建好，所以第一次讀不到。**跑第二次就會讀到**。
  - `• secret AE_API_TOKEN 未提供，略過`：步驟 4 的選用 token，之後再補。
  - `• r2.dev 公開網址維持關閉…；長期快取 Cache Rule 請依 docs/08 §6.1 手動建立`：照步驟 10 做。
- **為什麼要跑兩次**：第二次會讀到 team domain 並寫入（`✔ secret ACCESS_TEAM_DOMAIN 已同步`），總後台才能驗證登入。
  第二次跑時已建好的東西都會顯示 `已存在，略過`，金鑰顯示 `secret JWT_SECRET 已存在，不覆蓋`——**這是正確的**，重設金鑰會讓所有裝置登出、QR 全部失效。
  - 只想建資源、先不部署：`SKIP_DEPLOY=1 bash scripts/bootstrap.sh`，之後再 `bash scripts/deploy.sh`，然後一樣再跑一次 bootstrap。
- **可以重複執行**：中途失敗修好後直接再跑一次，已建好的會自動略過。改了 `ACCESS_ALLOWED_EMAILS` 也是重跑這個指令。
- **出錯怎麼辦**：
  - `安全閘：拒絕操作…` → 有東西的名稱不是 `call-` 開頭，腳本為了保護同帳號其他產品而停下。截圖給工程師，不要自己改名。
  - `token 無效或無法存取` → 步驟 4、7：token 貼錯或 Account ID 不對。
  - `You need a Workers Paid plan` → 回步驟 2。
  - `You need to enable Analytics Engine`（錯誤 10089）→ 程式已預設不綁 Analytics Engine，不應再出現；若出現請工程師確認 `apps/api/wrangler.toml`（步驟 10-2）。
  - 任何紅色錯誤 → 整段終端機輸出複製給工程師（輸出裡不含 token）。

### 步驟 10：快取規則（一定要做）＋ 啟用 Analytics Engine（選用）

網域**不用手動綁**：`call-api` 與 5 個網頁的網址由部署自動建立（含憑證），`call-media` 由步驟 9 自動綁好；沒有 CNAME 要設。

1. **長期快取規則（手動做一次）**：Websites → `jjoy.ai` → Caching → Cache Rules → Create rule：
   名稱 `call-media long cache`；條件 Hostname equals `call-media.jjoy.ai`；Cache eligibility 選 **Eligible for cache**；
   Edge TTL 選「Use cache-control header if present」；Browser TTL 選「Respect origin」→ Deploy。
   （腳本刻意不做：自動寫入會影響同網域其他產品的快取規則。廣告檔名含內容指紋，換內容就換檔名，所以可以快取一年。）
   **目前（2026-10-27）尚未建立**；沒有這條規則時廣告每次都回源（`cf-cache-status: MISS`），功能正常但較慢。
2. **（選用）啟用 Analytics Engine**：總後台「用量與成本」頁的每請求用量數字需要它。共用帳號目前**沒有啟用**（部署時曾出現錯誤 10089）。
   Workers & Pages → Analytics Engine → 啟用（帳號層級設定，腳本不代做）。啟用後請工程師把 `apps/api/wrangler.toml` 裡 Analytics Engine 那 3 行取消註解，
   再跑步驟 13 部署。不啟用也不影響叫號。
- **出錯怎麼辦**：某個 `call-` 網址打不開、部署時說網域已有紀錄 → DNS 頁看該 `call-` 子網域是否有舊紀錄衝突（**只刪 `call-` 開頭的**），再跑步驟 13。
- R2 若腳本提示「請手動」（實際部署時沒有發生）：R2 → `call-media-production` → Settings → Custom Domains → Add → `call-media.jjoy.ai`；
  CORS Policy 允許 Origins `https://call-display.jjoy.ai`、`https://call-store.jjoy.ai`、`https://call-admin.jjoy.ai`、`https://call-q.jjoy.ai`，Methods `GET`、`HEAD`。
  同一頁的 **Public Development URL（r2.dev）保持 Disabled**。

### 步驟 11：檢查總後台的 Cloudflare Access
- **實際狀態（2026-10-27）**：bootstrap 已自動建好 Access 應用 `call-admin`（保護整個 `call-admin.jjoy.ai`，包含 `/api/`）與 policy `call-admin-allow`（只允許 cf.env 名單內的 email），
  並把 AUD 與 team domain 存成 Worker secrets（team domain 要跑第二次 bootstrap 才有，見步驟 9）。
- **要做什麼**：用無痕視窗開 `https://call-admin.jjoy.ai` → 會跳到 `<team>.cloudflareaccess.com` 的登入頁，畫面有 **Email** 欄與 **Send login code** 按鈕 →
  輸入名單內的 email → 收信拿 6 位數驗證碼 → 進入總後台門店列表。
  - 截至 2026-10-27，自動測試只驗到「登入頁出現」；**用名單內 email 實際收碼登入，需要業主親自做一次確認**。
- 名單要增減：改 cf.env 的 `ACCESS_ALLOWED_EMAILS` → 跑 `bash scripts/bootstrap.sh`（同時更新 Access policy、Worker 的名單與平台管理員）。
- **出錯怎麼辦**：
  - 輸入 email 後顯示「無權限」→ policy 的 email 打錯或不在名單。
  - 進得去但後台顯示 401 → team domain 或 AUD 沒設好（多半是 bootstrap 只跑了一次），再跑一次 `bash scripts/bootstrap.sh`；或該 email 不在 cf.env 的名單裡（Worker 會再比一次）。
  - 登入頁沒有 Email 欄（只有其他登入方式）：Zero Trust → Settings → Authentication → Login methods → 新增 **One-time PIN**，並在 `call-admin` 應用的 Login methods 勾選它。
- 腳本無法自動建立時的手動做法：Zero Trust → Access → Applications → Add an application → Self-hosted：
  名稱 `call-admin`、Domain `call-admin.jjoy.ai`（Path 留空）、Policy `call-admin-allow`（Allow → Emails → 名單）、Login methods One-time PIN；
  存檔後把 Overview 的 **Application Audience (AUD) Tag** 與 team domain 填進 cf.env 的 `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`，再跑一次 bootstrap。

---

## C. 部署後在正式網址驗證（步驟 12）

bootstrap／deploy 最後會自動跑 smoke test，6 項全過才算部署成功：

| smoke 檢查 | 意思 |
|---|---|
| `✔ health <版本>` | API 回應，且版本＝這次部署的程式版本 |
| WebSocket hello／pong | 用 smoke 測試店帳號連上即時連線（叫號核心活著） |
| `✔ 5 個前端可連線` | 4 個網頁回 200；總後台回 302（轉到 Access 登入＝有保護） |
| `✔ call-admin 的 /api/* 未登入被擋` | 總後台的資料 API 沒登入拿不到 |
| `✔ API 網域的總後台路由未授權回 401` | 繞過登入頁直打 API 也拿不到 |
| `✔ call-media CORS 允許 call-display` | 面板可以讀廣告檔 |

### 12-1 灌 Demo 資料（虛構品牌「鮮迴壽司」3 家店）

```bash
pnpm seed:demo --env production --confirm
```

- **預期看到**：`• 正式環境安全檢查通過`、`✓ D1：…`、`✓ R2：Logo＋10 個素材 × 3 店`、`✓ KV：門店快取已清除`，最後每家店一段：門店碼、面板網址（`?token=…`）、人員網址、人員姓名與 PIN、店長帳號。
  完整密碼與裝置網址在 `~/.config/queue-call-system/demo-output.json`（權限 600，不要外流）。
- **只會動 DEMO 門店**（門店碼 `DEMOSK01`～`03`）：若同門店碼的店不是 Demo 店，腳本會中止。可以重複跑，密碼、PIN、已配對裝置沿用不變。
- 要整批刪掉 Demo 資料：`pnpm seed:demo --env production --confirm --reset`。細節見 [13-demo-seed](13-demo-seed.md)。

### 12-2 正式網址自動畫面測試（選用，約數分鐘）

```bash
pnpm e2e:prod
```

- **預期看到**：`5 passed`（主流程：面板 QR → 手機取號 → 人員叫號 → 面板大字＋語音 → 手機顯示被叫；門店後台；顧客頁 DEMO 標示；模擬叫號；總後台登入頁）。
  截圖在 `test-results/production/`。模擬叫號那一項只在 10:00–22:00 跑，其他時間顯示 skipped 屬正常。
- 會在 Demo「台中公益店」真的取一張號、叫號、完成，報表上會多一筆測試資料。

### 12-3 用真的手機與電視檢查

| 網址／動作 | 預期看到 |
|---|---|
| `https://call-api.jjoy.ai/health` | 一行文字 `{"ok":true,"version":"..."}` |
| `https://call-admin.jjoy.ai` | Access 登入（步驟 11）→ 總後台門店列表，看得到 3 家鮮迴壽司（smoke 測試店不顯示） |
| 手機開 `https://call-store.jjoy.ai`，用 demo-output.json 裡的店長帳號登入 | 門店後台即時隊列頁 |
| 電視（或電腦瀏覽器）開 demo-output.json 裡該店的面板網址 | 面板出現門店名稱、QR、廣告輪播；一般瀏覽器會先出現「尚未啟用聲音」提示 → 點一下聽到叮咚。台北中山店在 10:00–22:00、且有面板開著時，會每約 20 秒自動取號叫號（模擬叫號，總後台門店詳情可關） |
| （新面板）電視開 `https://call-display.jjoy.ai` | 顯示配對碼 → 在門店後台「裝置」輸入 → 面板出現門店畫面 |
| 手機掃面板上的 QR | 開到 `https://call-q.jjoy.ai/s/…` 顧客取號頁（有 Logo 與「DEMO・虛構品牌」標示）→ 選服務 → 填姓名手機 → 取號成功顯示號碼 |
| （正式叫號機）電視盒安裝叫號機 App（APK）→ 配對 → 拔插電源 | 不碰任何按鈕，開機後自動進入面板；叫號時直接出聲（不會出現「請點一下」）。若出現啟用聲音提示代表不是用 App 開的，門店後台也會顯示「無法出聲」警示 |
| 另一支手機開 demo-output.json 裡的人員網址 | 選人員 → 輸入 PIN → 選櫃台 → 按「叫下一號」→ 面板 1 秒內出現該號並唸出、顧客手機響鈴 |
| iPhone：顧客頁「加入主畫面」後再取號、鎖螢幕 | 叫號時收到推播通知 |

**媒體（廣告檔）檢查**（工程師或熟悉終端機的人做；`<廣告網址>` 可在電腦瀏覽器開面板、按 F12 → Network 篩選 `call-media` 取得，形如 `https://call-media.jjoy.ai/ads/<門店 id>/<64 位英數>.jpg`）：

1. 瀏覽器直接開 `<廣告網址>` → 看得到圖片或影片。
2. 看標頭：
   ```bash
   curl -sI <廣告網址>
   ```
   預期有 `cache-control: public, max-age=31536000, immutable`（2026-10-27 實測符合）；連續執行兩次，第二次 `cf-cache-status: HIT`（**要先做步驟 10-1 的 Cache Rule 才會 HIT**，目前是 MISS）。
3. 看 CORS（模擬面板來源）：
   ```bash
   curl -sI -H "Origin: https://call-display.jjoy.ai" <廣告網址> | grep -i access-control-allow-origin
   ```
   預期 `access-control-allow-origin: https://call-display.jjoy.ai`。把 Origin 換成 `https://example.org` 則**不應**出現這行（實測符合）。
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
  `deploy.sh` 會依序：型別檢查、`pnpm test`、`pnpm e2e`（**任何一項失敗就不會動到正式環境**）→ 記下目前版本 → 資料庫更新 → 部署 API → 部署 5 個網頁 → smoke。
  （剛在本機跑過 `pnpm e2e` 時，可用 `SKIP_E2E=1 bash scripts/deploy.sh` 省時間。）
- **預期看到**：最後顯示 `✔ smoke test 通過，部署完成`。接著照步驟 12 抽查（至少：取號 → 叫號 → 面板唸號；或跑 `pnpm e2e:prod`）。
- **出錯怎麼辦**：顯示 `smoke test 失敗，已自動回滾 Worker 到 <版本>` → API 已自動回到上一版（2026-10-27 實際發生過一次，自動回滾正常）。
  網頁沒有跟著回滾，需要時照步驟 14 加 `--frontends`。把輸出給工程師。
- 沒有自動部署：合併程式不會自己上線，一定是有人執行這個指令才會更新。

### 步驟 14：出事時回滾
- **要做什麼**：
  ```bash
  bash scripts/rollback.sh                          # API 回到上一版
  bash scripts/rollback.sh production --frontends   # API 與 5 個網頁都回到各自上一版
  bash scripts/rollback.sh production <版本 id>      # API 回到指定版本（版本 id 請工程師查）
  ```
  也可以在主控台：Workers & Pages → 該 Worker（例如 `call-display-production`）→ Deployments → 選上一個 → **Rollback**。
- **預期看到**：`✔ Worker call-api-production 已回滾`（加 `--frontends` 另有 5 行 `✔ 前端 call-…-production 已回滾到上一版`）；重新整理網頁恢復正常。
  2026-10-27 已實際演練：回滾後 `/health` 顯示舊版本、smoke 全過，再跑步驟 13 回到最新版。
- **絕對不要回滾到「最早的第一個版本」**：那個版本是第一次建置時、金鑰設定**之前**建出來的，裡面沒有任何金鑰，回去會整個壞掉。指定版本 id 時請工程師確認。
- **注意**：資料庫不會跟著回滾（設計上新版只會「加」欄位，舊版照樣能用）。資料本身出錯請找工程師用 Time Travel 還原。
  回滾後 API 的版本與程式最新版不同，直接跑 `bash scripts/smoke.sh` 會顯示「health 版本不符」——這是預期的，回到最新版後就正常。

### 步驟 15：確認夜間成本接近 0
- **要做什麼**：主控台 → Workers & Pages → `call-api-production` → 上方 **Durable Objects**（或 Metrics）→ 找 **Duration** 圖，時間範圍選「過去 24 小時」或「7 天」。
- **預期看到**：營業時間有起伏，**打烊後到開店前幾乎是平的、貼近 0**。總後台「用量與成本」頁沒有「夜間 DO 未休眠」警示。
  （台北中山店開著模擬叫號，營業時間 10:00–22:00 會固定有小量活動；22:00 後應歸零。）
- **出錯怎麼辦**：夜間也一直往上爬 → 代表有門店的程式沒進入休眠，會多花錢。截圖給工程師，並在總後台看哪家店有警示。
- 另外每月可在主控台 → Manage Account → Billing 看實際帳單（共用帳號的帳單包含其他產品），在總後台「帳單分攤」輸入本系統相關金額，就能看到每家店的實際成本。

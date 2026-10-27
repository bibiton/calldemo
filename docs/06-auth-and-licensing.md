# 06 — 身分、授權、門店開通

## 1. 身分種類

| 身分 | 用在 | 驗證方式 | Token |
|---|---|---|---|
| `platform_admin` | 總後台 | **Cloudflare Access**（email OTP 或 IdP），Worker 驗證 `Cf-Access-Jwt-Assertion`（JWKS 簽章、`aud`） | Access JWT |
| `store_admin` | 門店後台 | email＋密碼（PBKDF2-SHA256，WebCrypto） | Access token（JWT，15 分鐘）＋ refresh token（HttpOnly cookie，14 天） |
| `staff` | 人員端 | **已綁店的裝置**＋選人員＋6 位 PIN（ADR-004） | staff JWT（12 小時，一個班） |
| `device(display)` | 叫號面板 | 配對碼 | device token（JWT，長效 365 天，含 `token_version`） |
| `customer` | 顧客頁 | 動態 QR → 取號 session → ticket token | 取號 session（10 分鐘、單次）；ticket token（至號碼結束＋1 小時） |

### 密碼／PIN 雜湊

- `crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations})`，salt 16 bytes 隨機。
- iterations：**100,000**。
  - **M0 0.3 實測（2026-10-27，本機 workerd，`apps/api/test/m0-runtime.test.ts`）**：100,000 可用；**100,001 與 600,000 也都成功**——
    本機 workerd **不限制** iteration。社群所說「production 上限 100,000」本機無法驗證，**留待 staging 實測**。
  - 程式維持 100,000（兩邊都安全），且 `verifySecret` 拒絕 > 100,000 的雜湊字串，避免日後誤設高值在 production 才失敗。
  - CPU 成本只發生在登入時，可忽略。
- 格式：`pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>`，可在未來升級演算法時辨識舊格式。
- 比對使用 constant-time 比較。

### 暴力破解防護（不依賴付費 rate limit）

- 每帳號：連續失敗 5 次 → `locked_until = now + 15 分鐘`（D1）。
- 人員 PIN：只能在**已綁定該店的裝置**上嘗試（staff_device token 必須先存在），裝置綁定由店長操作 → 外部無法直接嘗試 PIN。
- 每店每分鐘登入失敗 > 20 → 該店 PIN 登入暫停 5 分鐘（計數放 DO，因為登入本來就要找該店，順便）。

### JWT

- HS256，`JWT_SECRET`（Worker secret）。claims：`sub`、`role`、`store_id`、`tv`（token_version）、`exp`。
- 撤銷：改密碼、停用帳號、解除裝置配對 → `token_version + 1`。Worker 驗證時比對（`token_version` 與 license 一起快取 60 秒）。

## 2. 門店開通（licensing）

D1 `stores` 是權威來源；KV `license:<storeId>` 是快取。

| 欄位 | 效果 |
|---|---|
| `status = suspended` | 全部 API 403、WS 立即斷線、面板顯示「服務暫停」、QR 區顯示「暫停取號」 |
| `expires_at < now` | 同上（原因顯示「已到期」）；**不需排程**，每次請求即時比對 |
| `max_devices` | 配對新面板時檢查 `active` 面板數 |
| `max_staff` | 新增人員時檢查 |
| `ad_quota_bytes` | 上傳廣告時檢查 `SUM(ad_assets.bytes WHERE status='ready')` |
| `features` | `push`、`ads`、`voice`、`showMaskedName` 開關，前端依 `hello` 顯示 |

### 檢查順序（每個 Worker 請求）

```
1. 解析身分 → 取得 storeId
2. license = isolateCache.get(storeId)          // 60 秒
          ?? KV.get("license:"+storeId, {cacheTtl:60})
          ?? D1 讀取並回填 KV
3. status !== 'active' || expires_at < now → 403 { code: "STORE_SUSPENDED" | "STORE_EXPIRED" }
4. 若為 WS upgrade 或 DO 呼叫，把 license 摘要帶進 DO（DO 存 meta.license_json，自身在喚醒時也會檢查到期）
```

### 停用生效時間

- 平台管理員按「停用」：Worker 同步做三件事 → D1 更新、KV 覆寫、`DO.suspend()`。
  → 已連線的面板與人員**立即**斷線；新請求在其他邊緣節點最遲 60 秒（isolate 快取＋KV cacheTtl）內 403。
- 恢復：反向操作；面板會依退避自動重連，不需人工。

## 3. 面板配對

```
面板開機（無 device token）→ POST /api/display/pair/start → 回 deviceId＋6 位配對碼（10 分鐘）
  面板顯示配對碼＋QR（內容：https://store.<domain>/pair?code=123456）
店長在門店後台（或用手機掃此 QR）輸入配對碼 → 檢查 max_devices → devices.status = active
面板輪詢 /api/display/pair/status（僅配對期間，每 3 秒，最多 10 分鐘）→ 取得 device token
```

- 配對期間的短暫輪詢是唯一允許的輪詢（每台面板一生只發生一次）。
- 解除配對：門店後台按「移除」→ `token_version + 1` → DO 關閉該裝置連線。
- 人員裝置（staff_device）同樣流程，差別是配對碼由人員手機顯示、店長確認。
- 實作（M3）：配對碼放獨立 `pairings` 表（配對前不屬於任何門店），裝置以「配對碼＋輪詢密鑰」領一次 token；`max_devices` 只計面板（ADR-036）。
  撤銷後面板／人員端在斷線時自查 token，401 回配對／登入畫面（ADR-037）。
- 門店後台 refresh cookie：`qcs_rt`，`HttpOnly; SameSite=Strict; Path=/api/store/auth`（本機 http 不加 `Secure`）；店長可用 access token 以 `role=staff` 連 WS（即時隊列代操作）。

## 4. 顧客取號的授權鏈

```
動態 QR token（120 秒窗，面板本地計算，ADR-012）
  → Worker 驗證 → 取號 session JWT（10 分鐘，jti 單次）
    → DO.takeTicket（session.jti 未用過、同手機無進行中號碼）
      → ticket token（只能操作此號碼：查詢、取消、訂閱推播、開 WS）
```

- 從 QR 網址外流到他人遠端取號：最多 4 分鐘有效窗口，且每個 session 只能取一張號、同手機只能一張進行中 → 灌號成本高。
- 門店若遭濫用：門店後台「重設 QR 金鑰」立即讓所有已流出的網址失效。

## 5. 個資存取權限

| 資料 | 顧客本人 | 面板 | 人員 | 店長 | 平台管理員 |
|---|---|---|---|---|---|
| 號碼 | ✅ | ✅ | ✅ | ✅ | ✅（歷史） |
| 姓名原文 | ✅ | ❌（可選顯示遮罩 王○明） | ✅ | ✅ | ❌ |
| 手機原文 | ✅ | ❌ | 遮罩 `0912***678`，**按住才顯示完整**（寫稽核 `pii.reveal`） | 同人員 | ❌ |
| 歷史（遮罩＋HMAC） | — | — | ❌ | ✅ 報表 | ✅ |

## 6. 稽核

寫入 `audit_logs` 的動作：門店建立／停用／恢復／延期／改上限、帳號建立／停用／重設、裝置配對／移除、
QR 金鑰重設、廣告上傳／刪除、`pii.reveal`、登入失敗鎖定、帳單分攤輸入。

- 平台與門店後台操作：Worker 直接寫 D1（量很小）。
- `pii.reveal`、人員登入等發生在 DO 的事件：併入 q-history 批次寫入，不另開寫入。
- `detail` 不得包含姓名／手機原文；`ip_hash` = HMAC(PHONE_PEPPER, ip)。
- 保存 365 天，Cron 清理。

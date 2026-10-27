# 03 — 資料模型

原則：**D1 放主檔＋歷史，即時寫入全在 DO SQLite**。D1 migration 只做向下相容的變更（加表、加 nullable 欄位、加索引），
不刪欄、不改名；要淘汰的欄位先停用一個版本以上再移除。

時間一律存 **UTC epoch 毫秒（INTEGER）**；營業日（`business_date`，`YYYY-MM-DD`）依門店時區計算後存字串。
ID 一律 TEXT（ULID），方便排序與跨表引用。

## 1. D1 schema（`apps/api/migrations/0001_init.sql`）

```sql
PRAGMA foreign_keys = ON;

-- 品牌：MVP 只建一筆預設品牌，UI 不顯示（ADR-002）
CREATE TABLE brands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- 品牌層是否統一下發廣告到旗下門店
  ads_push_enabled INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE stores (
  id            TEXT PRIMARY KEY,
  brand_id      TEXT NOT NULL REFERENCES brands(id),
  code          TEXT NOT NULL UNIQUE,              -- 短碼，用於 QR 網址 /s/<code>，6~8 碼 base32
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'     -- active | suspended
                CHECK (status IN ('active','suspended')),
  expires_at    INTEGER,                            -- NULL = 不到期
  max_devices   INTEGER NOT NULL DEFAULT 2,         -- 面板數上限
  max_staff     INTEGER NOT NULL DEFAULT 10,
  ad_quota_bytes INTEGER NOT NULL DEFAULT 524288000, -- 廣告容量上限，預設 500 MB
  features      TEXT NOT NULL DEFAULT '{}',         -- JSON：{"push":true,"ads":true,"voice":true,"showMaskedName":false}
  timezone      TEXT NOT NULL DEFAULT 'Asia/Taipei',
  business_hours TEXT NOT NULL DEFAULT '[]',        -- JSON：[{"dow":1,"open":"09:00","close":"21:00"},...]
  qr_key_version INTEGER NOT NULL DEFAULT 1,        -- 門店 QR 金鑰版本，輪替時 +1（ADR-012）
  voice_settings TEXT NOT NULL DEFAULT '{}',        -- JSON，叫號語音設定，結構見下方「門店語音設定」
  logo_r2_key   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_stores_brand ON stores(brand_id);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('platform_admin','store_admin','staff')),
  store_id       TEXT REFERENCES stores(id),        -- platform_admin 為 NULL
  display_name   TEXT NOT NULL,
  email          TEXT,                               -- store_admin 用；platform_admin 以 Access email 對應
  password_hash  TEXT,                               -- store_admin：PBKDF2，格式 pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>
  pin_hash       TEXT,                               -- staff：同格式（ADR-004）
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER,
  token_version  INTEGER NOT NULL DEFAULT 1,         -- 改密碼／停用時 +1，舊 JWT 失效
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_store ON users(store_id, role);

-- 裝置：面板（display）與人員端手機（staff_device）
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id),
  kind           TEXT NOT NULL CHECK (kind IN ('display','staff_device')),
  name           TEXT NOT NULL,
  pairing_code   TEXT,                               -- 6 位數，10 分鐘有效，配對成功即清空
  pairing_expires_at INTEGER,
  token_version  INTEGER NOT NULL DEFAULT 1,         -- 解除配對時 +1
  counter_id     TEXT,                               -- 面板可指定只顯示某些櫃台（NULL=全部）
  last_seen_at   INTEGER,                            -- 只在配對／重連時更新，不在心跳更新
  client_kind    TEXT,                               -- android_app | fully | chrome_kiosk | browser（ADR-027）
  audio_status   TEXT,                               -- ok | blocked；只在狀態改變時更新
  audio_status_at INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_devices_store ON devices(store_id, kind, status);
CREATE UNIQUE INDEX idx_devices_pairing ON devices(pairing_code) WHERE pairing_code IS NOT NULL;

-- 服務類別（字首 A/B/C...）
CREATE TABLE services (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id),
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 2),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  daily_limit INTEGER,                                -- NULL = 不限
  created_at  INTEGER NOT NULL,
  UNIQUE (store_id, prefix)
);

CREATE TABLE counters (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id),
  name        TEXT NOT NULL,                          -- 「3 號櫃台」
  number      INTEGER NOT NULL,                       -- 語音播報用
  service_ids TEXT NOT NULL DEFAULT '[]',             -- JSON：此櫃台可叫的服務類別
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE (store_id, number)
);

-- 歷史：號碼結束後由 q-history 批次寫入；不含個資原文（§4）
CREATE TABLE tickets_history (
  id            TEXT PRIMARY KEY,                     -- 與 DO 內 ticket id 相同，INSERT OR IGNORE 保證冪等
  store_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  number        TEXT NOT NULL,                        -- A013
  final_status  TEXT NOT NULL CHECK (final_status IN ('done','skipped','no_show','cancelled')),
  name_masked   TEXT,                                 -- 王○明
  phone_hmac    TEXT,                                 -- HMAC-SHA256(PHONE_PEPPER, 09xxxxxxxx) 前 32 hex
  phone_masked  TEXT,                                 -- 0912***678
  counter_id    TEXT,
  staff_id      TEXT,
  recall_count  INTEGER NOT NULL DEFAULT 0,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  called_at     INTEGER,
  serving_at    INTEGER,
  ended_at      INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr','staff'))
);
CREATE INDEX idx_hist_store_date ON tickets_history(store_id, business_date);
CREATE INDEX idx_hist_ended ON tickets_history(ended_at);

CREATE TABLE daily_stats (
  store_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  issued        INTEGER NOT NULL,
  done          INTEGER NOT NULL,
  skipped       INTEGER NOT NULL,
  no_show       INTEGER NOT NULL,
  cancelled     INTEGER NOT NULL,
  avg_wait_ms   INTEGER,                              -- created → called
  p90_wait_ms   INTEGER,
  avg_service_ms INTEGER,                             -- serving → ended
  peak_hour     INTEGER,                              -- 0-23（門店時區）
  PRIMARY KEY (store_id, business_date, service_id)
);

-- Web Push 訂閱：號碼結束即刪；Cron 清孤兒（> 24h）
CREATE TABLE push_subscriptions (
  ticket_id   TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_push_created ON push_subscriptions(created_at);

-- 廣告素材（ADR-016）
CREATE TABLE ad_assets (
  id           TEXT PRIMARY KEY,
  owner_type   TEXT NOT NULL CHECK (owner_type IN ('store','brand')),
  owner_id     TEXT NOT NULL,                         -- store_id 或 brand_id
  kind         TEXT NOT NULL CHECK (kind IN ('image','video')),
  r2_key       TEXT NOT NULL,                         -- ads/<owner>/<sha256>.<ext>，內容不可變
  sha256       TEXT NOT NULL,
  mime         TEXT NOT NULL,                         -- image/jpeg|image/png|image/webp|video/mp4
  bytes        INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,                               -- 影片
  status       TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','deleted')),
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_ad_assets_owner ON ad_assets(owner_type, owner_id, status);

CREATE TABLE ad_playlists (
  id           TEXT PRIMARY KEY,
  owner_type   TEXT NOT NULL CHECK (owner_type IN ('store','brand')),
  owner_id     TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,            -- 任何變更 +1，面板以此判斷 manifest 是否更新
  accept_brand INTEGER NOT NULL DEFAULT 1,            -- 門店層：是否接受品牌統一下發的項目
  updated_at   INTEGER NOT NULL,
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE ad_playlist_items (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES ad_playlists(id),
  asset_id     TEXT NOT NULL REFERENCES ad_assets(id),
  sort_order   INTEGER NOT NULL,
  duration_ms  INTEGER,                               -- 圖片停留秒數；影片 NULL = 播完
  active_from  TEXT,                                  -- 'HH:MM'（門店時區），NULL = 全天
  active_to    TEXT,
  active_dows  TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  start_date   TEXT,                                  -- 'YYYY-MM-DD'，NULL = 不限
  end_date     TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ad_items_playlist ON ad_playlist_items(playlist_id, sort_order);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('platform_admin','store_admin','staff','device','system')),
  actor_id    TEXT NOT NULL,
  store_id    TEXT,
  action      TEXT NOT NULL,      -- store.suspend / store.extend / user.create / device.revoke / pii.reveal / qr.rotate ...
  target      TEXT,
  detail      TEXT,               -- JSON，不得含個資原文
  ip_hash     TEXT
);
CREATE INDEX idx_audit_store_at ON audit_logs(store_id, at);
CREATE INDEX idx_audit_at ON audit_logs(at);
```

### 門店語音設定（`stores.voice_settings` JSON）

一店一份、很少改、只由面板讀取 → 用 JSON 欄位，不另開表（少一次 JOIN、少一張 migration）。
片段 id 與主題包 tag 以 `assets/audio/manifest.json` 為準（另案產生）。

```jsonc
{
  "volume": 0.8,                 // 0~1
  "repeat": 2,                   // 叫號句唸幾次 1~3
  "chime": "chime.dingdong",     // 叮咚音效＝manifest 的 key（chime.dingdong／chime.bright／chime.bell）
  "lang": "zh-TW",
  "mode": "fun",                 // "fun" = 俏皮前綴；"standard" = 一律「來賓」
  "funPrefixProb": 0.3,          // 俏皮前綴出現機率 0~1（其餘次數用標準「來賓」）
  "venue": "any",                // "food" 才使用 manifest 中 venue=food 的句子（餐飲限定）
  "enabledPacks": ["hungry", "warm"],    // manifest prefixPacks 的 key；空陣列 = 各句 defaultEnabled
  "disabledLines": ["prefix.wait05"],    // 個別停用的單句（manifest key）；manualOnly（生日）一律不進隨機池
  "muteRanges": [{ "from": "12:00", "to": "13:00" }]
}
```

- 缺欄位一律採預設值（上例數字即預設，`mode` 預設 `"fun"`）。
- 趣味穿插語音已取消（ADR-033）：不再有 `interjection` 欄位；舊資料若帶此欄位，讀取時忽略、儲存時丟棄。
- 變更時 DO 廣播 `settings.changed`，面板重抓設定。

### 用量計量表

`usage_hourly`、`usage_daily`、`usage_monthly`、`billing_inputs` 在 migration `0002_usage.sql`，完整 SQL 見
[12-usage-metering §3](12-usage-metering.md#3-資料表d1追加-migration-0002_usagesql)。皆不含個資。

## 2. KV

| Key | Value | TTL | 寫入時機 |
|---|---|---|---|
| `license:<storeId>` | `{"status":"active","expiresAt":...,"maxDevices":2,"features":{...},"qrKeyVersion":1,"v":17}` | 不設（以 Worker 端 cacheTtl 60s 讀取） | 平台管理員改門店時 |
| `storecode:<code>` | `<storeId>` | 不設 | 建店時 |

讀取路徑：isolate 記憶體 Map（60 秒）→ `KV.get(key, {cacheTtl: 60})` → miss 時讀 D1 並回填 KV。

## 3. DO SQLite schema（StoreQueueDO，每店一份）

DO 啟動時以 `blockConcurrencyWhile` 執行 schema migration。版本號存在 `meta.schema_version`（實作時改用 meta 列，不依賴 DO SQLite 是否開放 `PRAGMA user_version`；只加不刪）。
實作版（`apps/api/src/do/schema.ts`）與下列 SQL 的差異：`tickets` 多 `sort_key`（requeue 排隊尾／原位，ADR-029）、
多 `audit_buffer` 表（`pii.reveal`、面板音訊狀態等先在 DO 暫存，隨 q-history 批次寫 D1）。

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 內容：store_id, timezone, business_date（目前營業日）,
--       state（JSON：seq 最後事件序號＋用量計數小時桶，每事件寫一次，見 12-usage-metering §2）,
--       license_json（最近一次從 Worker 帶入的開通狀態）, settings_version, ads_manifest_version

CREATE TABLE counters_seq (            -- 每服務類別每營業日的取號序號
  service_id    TEXT NOT NULL,
  business_date TEXT NOT NULL,
  last_no       INTEGER NOT NULL,
  PRIMARY KEY (service_id, business_date)
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  no            INTEGER NOT NULL,
  number        TEXT NOT NULL,          -- A013
  status        TEXT NOT NULL CHECK (status IN
                ('waiting','called','serving','done','skipped','no_show','cancelled')),
  name          TEXT,                   -- 原文，關店 alarm 清除（§4）
  phone         TEXT,                   -- 原文 09xxxxxxxx，關店 alarm 清除
  phone_hmac    TEXT NOT NULL,          -- 防重複用；保留至寫入 D1
  counter_id    TEXT,
  staff_id      TEXT,
  recall_count  INTEGER NOT NULL DEFAULT 0,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  push_enabled  INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'qr',
  created_at    INTEGER NOT NULL,
  called_at     INTEGER,
  serving_at    INTEGER,
  ended_at      INTEGER,
  flushed       INTEGER NOT NULL DEFAULT 0,   -- 已送 q-history
  UNIQUE (business_date, service_id, no)
);
CREATE INDEX t_active ON tickets(status, service_id, created_at);
-- 同店同手機只能有一張進行中號碼（DB 層保證，不只靠程式判斷）
CREATE UNIQUE INDEX t_phone_active ON tickets(phone_hmac)
  WHERE status IN ('waiting','called','serving');

CREATE TABLE events (                 -- 補推用；保留當日＋前一日
  seq     INTEGER PRIMARY KEY,         -- 單調遞增，不重用
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL                -- 已去個資的 JSON（面板／顧客可收的版本）
);

CREATE TABLE cmd_dedup (               -- 人員指令冪等：cmdId 已處理過就回原結果
  cmd_id  TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  result  TEXT NOT NULL
);

CREATE TABLE take_sessions (           -- QR 取號 session 單次使用
  jti     TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  ticket_id TEXT NOT NULL
);
```

### 號碼生命週期

```
            callNext / call(id)        startServing           finish
 waiting ───────────────────▶ called ─────────────▶ serving ───────────▶ done
    ▲                          │  │ recall（recall_count+1，仍為 called）
    │ transfer（換服務/櫃台，   │  ├────────▶ skipped（過號；可 requeue 回 waiting）
    │  transfer_count+1）       │  └────────▶ no_show（多次叫未到）
    └──────────────────────────┘
 waiting ──cancel（顧客自行取消）──▶ cancelled
```

- `recall` 不是獨立狀態，是 `called` 上的動作（`recall_count` 遞增、重新廣播）。
- `skipped` 可由店員 `requeue` 回 `waiting`（排到隊尾或原位置，門店設定）；`no_show` 為終態。
- 終態：`done`、`no_show`、`cancelled`，以及營業日結束時仍為 `skipped` 者。

### 每日歸零

**不靠 alarm 歸零**：每次取號時以門店時區算出 `business_date`，若與 `meta.business_date` 不同，
即在同一個交易內切換營業日、序號從 1 起算（`counters_seq` 以 `business_date` 為鍵，天然歸零）。
→ 不需要任何「午夜叫醒 DO」的動作。

唯一的定時工作是**每日關店 alarm**（關店時間＋30 分鐘，一天一次），做三件事：
1. 未結束的號碼標為終態（`waiting/called/skipped` → `no_show`）並送 q-history
2. 清除當日所有 `name`、`phone` 原文
3. 刪除前一營業日之前的 `events`、`cmd_dedup`、`take_sessions`、已 flushed 的 `tickets`

## 4. 個資保存與清理

| 資料 | 存哪 | 保存期限 | 清理機制 |
|---|---|---|---|
| 姓名原文、手機原文 | DO `tickets` | **至該營業日關店後 30 分鐘**（≤ 24 小時） | DO 每日關店 alarm 設為 NULL |
| 手機 HMAC | DO → D1 `tickets_history.phone_hmac` | D1 **90 天** | Cron 每日刪除 `ended_at < now-90d` |
| 遮罩姓名 `王○明`、遮罩手機 `0912***678` | D1 `tickets_history` | 90 天 | 同上 |
| 推播訂閱（endpoint、金鑰） | D1 `push_subscriptions` | **號碼結束即刪** | q-history consumer 刪除該批；Cron 刪除 `created_at < now-24h` 的孤兒 |
| 每日統計 | D1 `daily_stats` | 永久（無個資） | — |
| 稽核紀錄 | D1 `audit_logs` | 365 天（不含個資原文） | Cron 每日刪除 |

- `phone_hmac` 使用 Worker secret `PHONE_PEPPER` 做 HMAC-SHA256；**不可用純 SHA-256**——台灣手機號碼空間只有 10⁸，純雜湊可被暴力還原。
- 用途：防重複取號（DO 內）、回訪次數統計（D1，未來）。
- 個資同意文字（顧客頁顯示）：蒐集目的「叫號與現場聯繫」；姓名與手機原文於當日營業結束後刪除；遮罩後資料與不可逆編碼保存 90 天供統計後刪除。

### 遮罩規則（`packages/shared/mask.ts`）

| 輸入 | 輸出 | 規則 |
|---|---|---|
| 王明 | 王○ | 2 字：保留首字 |
| 王小明 | 王○明 | 3 字：保留首尾 |
| 歐陽小明 | 歐○○明 | ≥ 4 字：保留首尾，中間全遮 |
| Alice | A○○○e | 拉丁字母同上 |
| 0912345678 | 0912***678 | 保留前 4 後 3 |

## 5. 容量檢查

- D1 `tickets_history`：500 店 × 300 號 × 90 天 = 13.5M 列 × 約 400 B（含索引）≈ **5.4 GB**，低於單庫 10 GB 上限。
  超過 7 GB 時的對策（依序）：縮短明細保留天數 → 依品牌或區域分庫。
- DO SQLite：每店只保留 2 個營業日的資料，約 < 5 MB，遠低於單物件 10 GB。

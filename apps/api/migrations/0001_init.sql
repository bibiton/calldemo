-- 0001_init：來源 docs/03-data-model.md §1（向下相容規則見 08 §5）
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

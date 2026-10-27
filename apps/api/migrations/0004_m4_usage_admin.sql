-- 0004：M4 計量（12-usage-metering §3）＋總後台＋M5 PIN 限流。向下相容：只加表、加欄位、加索引。
-- 用量表皆不含個資。時間一律 UTC epoch ms；usage_daily.date 為 UTC 日期（與 Cloudflare 計費日一致）。

CREATE TABLE usage_hourly (            -- 保留 35 天（保留期限 Cron）
  store_id     TEXT NOT NULL,          -- 門店 id；'_platform'＝不屬於任何門店的請求（健康檢查、配對、平台後台）
  hour_start   INTEGER NOT NULL,       -- UTC 整點
  api_requests INTEGER NOT NULL DEFAULT 0,   -- 來源：Analytics Engine（每日 Cron 匯入，覆寫）
  api_errors   INTEGER NOT NULL DEFAULT 0,   -- 5xx
  api_wall_ms  INTEGER NOT NULL DEFAULT 0,
  ws_connects  INTEGER NOT NULL DEFAULT 0,   -- 以下 DO 欄位：關店 alarm 隨 q-history 送出的小時桶（累加）
  ws_messages  INTEGER NOT NULL DEFAULT 0,
  do_rpc       INTEGER NOT NULL DEFAULT 0,
  do_alarms    INTEGER NOT NULL DEFAULT 0,
  do_wakes     INTEGER NOT NULL DEFAULT 0,
  do_night_wakes INTEGER NOT NULL DEFAULT 0, -- 非營業時間喚醒（DO 直接寫 AE、每日 Cron 匯入、覆寫；ADR-044）
  do_events    INTEGER NOT NULL DEFAULT 0,
  do_rows_written INTEGER NOT NULL DEFAULT 0,
  tickets      INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  push_sent    INTEGER NOT NULL DEFAULT 0,   -- q-push consumer 每批依店累加（ADR-044）
  push_failed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, hour_start)
);
CREATE INDEX idx_usage_hourly_hour ON usage_hourly(hour_start);

CREATE TABLE usage_daily (             -- 永久（每店每日一列）
  store_id     TEXT NOT NULL,
  date         TEXT NOT NULL,          -- UTC 日期 YYYY-MM-DD
  api_requests INTEGER NOT NULL DEFAULT 0,
  api_errors   INTEGER NOT NULL DEFAULT 0,
  ws_connects  INTEGER NOT NULL DEFAULT 0,
  ws_messages  INTEGER NOT NULL DEFAULT 0,
  do_rpc       INTEGER NOT NULL DEFAULT 0,
  do_wakes     INTEGER NOT NULL DEFAULT 0,
  do_requests_est INTEGER NOT NULL DEFAULT 0,     -- ws_messages/20 + ws_connects + do_rpc + do_alarms
  do_active_seconds_est REAL NOT NULL DEFAULT 0,  -- events×0.05 + wakes×0.01（係數待 staging 校正）
  do_rows_written_est INTEGER NOT NULL DEFAULT 0,
  do_wakes_offhours INTEGER NOT NULL DEFAULT 0,   -- 非營業時間的喚醒次數（門店時區）
  do_wakes_offhours_max INTEGER NOT NULL DEFAULT 0, -- 非營業時間單一小時最多喚醒次數（夜間警示：> 10／小時）
  tickets      INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  push_sent    INTEGER NOT NULL DEFAULT 0,
  push_failed  INTEGER NOT NULL DEFAULT 0,
  r2_bytes     INTEGER NOT NULL DEFAULT 0,       -- 彙總當時的廣告儲存量
  d1_history_rows INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,          -- 依單價估算（不扣內含額度）
  PRIMARY KEY (store_id, date)
);
CREATE INDEX idx_usage_daily_date ON usage_daily(date);

CREATE TABLE usage_monthly (
  store_id      TEXT NOT NULL,
  month         TEXT NOT NULL,         -- 'YYYY-MM'（UTC）
  active_days   INTEGER NOT NULL DEFAULT 0,
  api_requests  INTEGER NOT NULL DEFAULT 0,
  api_errors    INTEGER NOT NULL DEFAULT 0,
  ws_connects   INTEGER NOT NULL DEFAULT 0,
  ws_messages   INTEGER NOT NULL DEFAULT 0,
  do_requests_est INTEGER NOT NULL DEFAULT 0,
  do_active_seconds_est REAL NOT NULL DEFAULT 0,
  do_rows_written_est INTEGER NOT NULL DEFAULT 0,
  do_wakes_offhours INTEGER NOT NULL DEFAULT 0,
  tickets       INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  push_sent     INTEGER NOT NULL DEFAULT 0,
  push_failed   INTEGER NOT NULL DEFAULT 0,
  r2_byte_days  INTEGER NOT NULL DEFAULT 0,
  est_cost_usd       REAL NOT NULL DEFAULT 0,
  allocated_cost_usd REAL,             -- 依實際帳單分攤（輸入帳單後才有）
  PRIMARY KEY (store_id, month)
);

CREATE TABLE billing_inputs (          -- 每月實際帳單（總後台輸入）
  month        TEXT NOT NULL,
  line_item    TEXT NOT NULL,          -- workers_base / workers_requests / workers_cpu / do_requests / do_duration /
                                       -- do_storage / d1 / kv / r2 / queues / analytics_engine / other
  amount_usd   REAL NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('invoice','graphql_estimate')),
  entered_by   TEXT,
  entered_at   INTEGER NOT NULL,
  PRIMARY KEY (month, line_item)
);

-- 總後台「刪除門店」＝封存（ADR-043）：不刪資料列（歷史、稽核、計量仍可查），列表預設不顯示
ALTER TABLE stores ADD COLUMN deleted_at INTEGER;

-- 稽核依動作篩選
CREATE INDEX idx_audit_action_at ON audit_logs(action, at);

-- M5：每店人員 PIN 登入失敗計數（06 §1：每店每分鐘失敗 > 20 → 該店 PIN 登入暫停 5 分鐘，ADR-046）
CREATE TABLE pin_failures (
  store_id  TEXT NOT NULL,
  minute    INTEGER NOT NULL,          -- floor(epoch ms / 60000)
  n         INTEGER NOT NULL,
  PRIMARY KEY (store_id, minute)
);

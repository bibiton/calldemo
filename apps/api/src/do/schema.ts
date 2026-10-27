/**
 * DO SQLite schema（03-data-model §3）。以 PRAGMA user_version 向前遷移；只加不刪。
 * 與文件差異：tickets 多 sort_key（requeue 排隊尾／原位）、多 audit_buffer（pii.reveal、裝置音訊狀態等
 * 併入 q-history 批次送 D1，06-auth §6）。見 DECISIONS ADR-029。
 */
export const DO_MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters_seq (
  service_id TEXT NOT NULL, business_date TEXT NOT NULL, last_no INTEGER NOT NULL,
  PRIMARY KEY (service_id, business_date)
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  service_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  no INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','called','serving','done','skipped','no_show','cancelled')),
  name TEXT,
  phone TEXT,
  phone_hmac TEXT NOT NULL,
  counter_id TEXT,
  staff_id TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'qr',
  sort_key INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  called_at INTEGER,
  serving_at INTEGER,
  ended_at INTEGER,
  flushed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_date, service_id, no)
);
CREATE INDEX IF NOT EXISTS t_active ON tickets(status, service_id, sort_key);
CREATE UNIQUE INDEX IF NOT EXISTS t_phone_active ON tickets(phone_hmac) WHERE status IN ('waiting','called','serving');
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cmd_dedup (cmd_id TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS take_sessions (jti TEXT PRIMARY KEY, at INTEGER NOT NULL, ticket_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_buffer (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
`,
  // v2（M2）：推播「快輪到您了」只送一次
  `ALTER TABLE tickets ADD COLUMN push_soon_sent INTEGER NOT NULL DEFAULT 0;`,
];

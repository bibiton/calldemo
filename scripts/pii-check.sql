-- 5.2 個資抽查（03 §4、ADR-015）。回傳一列，每一欄都必須是 0。只讀，不改資料。
-- 正式環境：bash scripts/pii-check.sh；本機：bash scripts/pii-check.sh --local [--persist-to <dir>]
-- （D1 限制 compound SELECT 項數，所以用一列多個子查詢）
SELECT
  (SELECT count(*) FROM tickets_history WHERE name_masked IS NOT NULL AND length(name_masked) >= 2 AND instr(name_masked, '○') = 0) AS "tickets_history 姓名未遮罩",
  (SELECT count(*) FROM tickets_history WHERE phone_masked IS NOT NULL AND phone_masked NOT GLOB '09[0-9][0-9][*][*][*][0-9][0-9][0-9]') AS "tickets_history 手機未遮罩",
  (SELECT count(*) FROM tickets_history WHERE phone_hmac IS NOT NULL AND (length(phone_hmac) <> 32 OR phone_hmac GLOB '*[^0-9a-f]*')) AS "tickets_history 手機 HMAC 格式不對",
  (SELECT count(*) FROM tickets_history WHERE ended_at < (unixepoch() - 91 * 86400) * 1000) AS "tickets_history 超過 90 天未清",
  (SELECT count(*) FROM audit_logs WHERE detail GLOB '*09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*' OR target GLOB '*09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*') AS "audit_logs 疑似完整手機",
  (SELECT count(*) FROM audit_logs WHERE at < (unixepoch() - 366 * 86400) * 1000) AS "audit_logs 超過 366 天未清",
  (SELECT count(*) FROM push_subscriptions WHERE created_at < (unixepoch() - 25 * 3600) * 1000) AS "push_subscriptions 超過 25 小時未清",
  (SELECT count(*) FROM transfer_codes WHERE expires_at < (unixepoch() - 86400) * 1000) AS "transfer_codes 過期超過 1 天未清";

-- 0002：M2 通知（07-notifications）。只做向下相容變更（08 §5）：加欄位（有預設值）、加表。
-- 前面剩幾位時發「快輪到您了」推播（門店可設 1～5，07 §1）
ALTER TABLE stores ADD COLUMN notify_ahead INTEGER NOT NULL DEFAULT 3;

-- iOS 加入主畫面的號碼轉交碼（07 §3）：Safari 與主畫面 app 不共用 localStorage，以一次性短碼轉交。
-- 只存 ticket_id，兌換時重新簽 ticket token（不在 D1 存任何可直接使用的憑證）。10 分鐘有效、單次使用。
CREATE TABLE transfer_codes (
  code        TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_xfer_expires ON transfer_codes(expires_at);

-- 0003：M3 門店後台（向下相容：只加表）
-- 面板／人員手機配對（06-auth §3）：配對碼由裝置顯示，店長在門店後台輸入。
-- 裝置在配對前不屬於任何門店，所以不能直接寫 devices（store_id NOT NULL）；確認後才建立 devices 列。
CREATE TABLE pairings (
  code        TEXT PRIMARY KEY,                       -- 6 位數，10 分鐘
  kind        TEXT NOT NULL CHECK (kind IN ('display','staff_device')),
  poll_hash   TEXT NOT NULL,                          -- SHA-256(輪詢密鑰)；只有顯示配對碼的那台裝置能領 token
  store_id    TEXT,                                   -- 店長確認後填入
  device_id   TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_pairings_expires ON pairings(expires_at);

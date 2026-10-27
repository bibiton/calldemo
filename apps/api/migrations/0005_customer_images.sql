-- 0005：顧客手機圖片（ADR-048）。廣告項目可勾選「顯示於顧客手機」（預設關）；只限圖片，顧客頁輪播、取號頁主視覺。
ALTER TABLE ad_playlist_items ADD COLUMN show_on_customer INTEGER NOT NULL DEFAULT 0;

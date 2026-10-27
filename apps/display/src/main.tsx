import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";

// 語音包與廣告素材：Service Worker cache-first（只在正式建置啟用，避免開發時快取干擾）
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(<App />);

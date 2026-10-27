// 面板 Service Worker：語音包（/audio/）與廣告素材 cache-first，之後斷網照播（ADR-026、07 §7）。
// 漸進預載（依啟用主題包與當日號碼範圍）留待 M3 3.5 一併實作。
const CACHE = "qcs-display-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const cacheable = e.request.method === "GET" && (url.pathname.startsWith("/audio/") || url.pathname.startsWith("/demo-ads/") || url.pathname.startsWith("/ads/"));
  if (!cacheable) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }),
  );
});

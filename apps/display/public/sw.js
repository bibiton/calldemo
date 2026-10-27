// 面板 Service Worker：語音包（/audio/）與廣告素材 cache-first，之後斷網照播（ADR-026、07 §7）。
// 漸進預載由頁面端 AudioWarmer 依序 fetch（經過這裡進快取）；廣告清單更新時頁面送 ads-keep，刪掉不再使用的素材。
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

self.addEventListener("message", (e) => {
  if (!e.data || e.data.t !== "ads-keep" || !Array.isArray(e.data.urls)) return;
  const keep = new Set(e.data.urls);
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      for (const req of await c.keys()) {
        const p = new URL(req.url).pathname;
        if ((p.startsWith("/ads/") || p.startsWith("/demo-ads/")) && !keep.has(req.url)) await c.delete(req);
      }
    }),
  );
});

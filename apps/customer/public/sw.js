// 顧客頁 Service Worker：只處理 Web Push 與通知點擊（07-notifications §4），不做離線快取。
importScripts("/notify-text.js");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = null;
  try {
    p = e.data ? e.data.json() : null;
  } catch (_) {
    p = null;
  }
  const n = self.qcsNotification(p);
  e.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const w of list) {
        if (new URL(w.url).origin === self.location.origin) return w.focus().then((c) => c && c.navigate ? c.navigate(url) : c);
      }
      return self.clients.openWindow(url);
    }),
  );
});

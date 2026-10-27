// 推播通知文字（07-notifications §1）：payload 只帶資料，文字在這裡組。sw.js 以 importScripts 載入；E2E 也直接驗證。
self.qcsNotification = function (p) {
  var n = String(p && p.n || "");
  var c = p && p.c ? p.c + " 號櫃台" : "櫃台";
  var tag = "qcs-" + String(p && p.id || "ticket");
  var base = { tag: tag, renotify: true, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: (p && p.url) || "/" }, lang: "zh-TW" };
  if (p && p.t === "called") {
    return { title: (p.r ? "再次叫號：" : "輪到您了！") + n, options: Object.assign(base, { body: "請到 " + c, requireInteraction: true, vibrate: [400, 200, 400, 200, 400] }) };
  }
  if (p && p.t === "skipped") {
    return { title: n + " 已過號", options: Object.assign(base, { body: "請洽櫃台人員", requireInteraction: true }) };
  }
  if (p && p.t === "soon") {
    return { title: "快輪到您了", options: Object.assign(base, { body: n + " 前面還有 " + (p.a || 0) + " 位，請回到店內留意叫號" }) };
  }
  return { title: "叫號提醒", options: Object.assign(base, { body: n }) };
};

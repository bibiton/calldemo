/**
 * M2 通知：前景提醒（1 秒內全螢幕＋響鈴＋震動）、背景 Web Push（DO → q-push → consumer → 假 push service，Node 端解密驗證）、
 * Service Worker 通知文字、權限被拒、iOS 加入主畫面教學＋轉交碼。
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PHONE, SMALL, URLS, apiTake, layoutIssues, openDisplay, qrUrl, seed, shot, staffLogin } from "./helpers";
import { decrypt, fakePushServer, stubPushScript, uaKeys, verifyVapid } from "./push-helper";

test.describe.configure({ mode: "serial" });

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function takeViaUi(browser: Browser, url: string, name: string, phone: string, opts = PHONE, init?: string, perms: string[] = []) {
  const ctx = await browser.newContext(opts);
  if (perms.length) await ctx.grantPermissions(perms, { origin: URLS.customer });
  if (init) await ctx.addInitScript({ content: init });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByTestId("service-A").click();
  await page.getByTestId("name").fill(name);
  await page.getByTestId("phone").fill(phone);
  await page.getByTestId("consent").check();
  await page.getByTestId("submit").click();
  await page.getByTestId("my-number").waitFor();
  return page;
}

async function callUntil(staff: Page, number: string) {
  // 叫下一號直到叫到指定號碼（前面可能有其他測試留下的號碼）
  for (let i = 0; i < 20; i++) {
    const loc = staff.getByTestId("current-number");
    const cur = (await loc.count()) ? (await loc.textContent())?.trim() : null;
    if (cur === number) return;
    await staff.getByTestId("call-next").click();
    await staff.waitForTimeout(250);
  }
  throw new Error("沒有叫到 " + number);
}

test("2.1 前景提醒：人員叫號 → 顧客頁 1 秒內全螢幕紅底＋響鈴＋震動；重叫再跳一次", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const vib = `window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; };`;
  const customer = await takeViaUi(browser, url, "提醒測試", "0955000001", PHONE, vib);
  const number = (await customer.getByTestId("my-number").textContent())!.trim();
  await shot(customer, "notify-01-ticket-foreground");
  const staff = await staffLogin(browser, s);
  const t0 = Date.now();
  await callUntil(staff, number);
  await expect(customer.getByTestId("called-alert")).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(1000 * 20); // 叫到前面的號碼也算在內；單次延遲另外量
  // 單次延遲：重叫 → 顧客頁再跳出提醒 < 1 秒
  await customer.getByRole("button", { name: "我知道了" }).click();
  await expect(customer.getByTestId("called-alert")).toHaveCount(0);
  const t1 = Date.now();
  await staff.getByTestId("act-recall").click();
  await expect(customer.getByTestId("called-alert")).toBeVisible();
  expect(Date.now() - t1).toBeLessThan(1000);
  await expect(customer.getByTestId("called-alert")).toContainText("再次叫號");
  expect(await customer.evaluate(() => (window as any).__qcsRang ?? 0)).toBeGreaterThanOrEqual(2);
  expect((await customer.evaluate(() => (window as any).__vib)).length).toBeGreaterThanOrEqual(2);
  await shot(customer, "notify-02-recall-alert");
  await staff.getByTestId("act-finish").click().catch(() => {});
  await staff.context().close();
  await customer.context().close();
  await display.context().close();
});

test("2.2 背景推播：訂閱 → 顧客關掉頁面 → 叫號 → 假推播端點收到 aes128gcm 加密、VAPID 簽章的推播（Node 端解密驗證）", async ({ browser }) => {
  const s = seed("DEMO01");
  const { server, got } = await fakePushServer(6190);
  try {
    const ua = uaKeys();
    const endpoint = `http://127.0.0.1:6190/push/${Date.now()}`;
    const display = await openDisplay(browser, s);
    const url = await qrUrl(display);
    const customer = await takeViaUi(browser, url, "推播測試", "0955000002", PHONE, stubPushScript(endpoint, ua), ["notifications"]);
    const number = (await customer.getByTestId("my-number").textContent())!.trim();
    await expect(customer.getByTestId("push-on")).toBeVisible();
    await expect(customer.getByTestId("push-on")).toContainText("背景提醒已開啟");
    expect(await customer.evaluate(() => (window as any).__qcsSubscribed)).toBe(1);
    await shot(customer, "notify-03-push-on");
    expect(await layoutIssues(customer)).toEqual([]);
    // 顧客離開（關掉頁面）：WS 斷線，之後的叫號改走 Web Push
    await customer.context().close();
    const staff = await staffLogin(browser, s);
    await callUntil(staff, number);
    await expect.poll(() => got.filter((g) => g.path.startsWith("/push/")).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const req = got.find((g) => g.path === new URL(endpoint).pathname)!;
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers["ttl"]).toBe("120");
    expect(req.headers["urgency"]).toBe("high");
    const v = verifyVapid(String(req.headers["authorization"]), "http://127.0.0.1:6190");
    expect(v.ok).toBe(true);
    expect(v.claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
    const payload = JSON.parse(decrypt(req.body, ua));
    expect(payload).toMatchObject({ t: "called", n: number, c: 1 });
    expect(payload.url).toMatch(/^\/t\//);
    await staff.getByTestId("act-finish").click().catch(() => {});
    await staff.context().close();
    await display.context().close();
  } finally {
    server.close();
  }
});

test("2.2 Service Worker：收到推播 → 顯示通知（叫號／快輪到／過號的文字）", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  await ctx.grantPermissions(["notifications"], { origin: URLS.customer });
  const page = await ctx.newPage();
  await page.goto(URLS.customer + "/resume");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const cdp = await ctx.newCDPSession(page);
  const regId = new Promise<string>((resolve) =>
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: any) => {
      const r = e.registrations.find((x: any) => x.scopeURL.startsWith(URLS.customer) && !x.isDeleted);
      if (r) resolve(r.registrationId);
    }),
  );
  await cdp.send("ServiceWorker.enable");
  const id = await regId;
  const deliver = async (p: object) => {
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: URLS.customer + "/", registrationId: id, data: JSON.stringify(p) });
  };
  const count = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  const payloads = [
    { t: "called", n: "A023", c: 2, a: 0, r: 0, id: "t1", url: "/t/t1" },
    { t: "soon", n: "A030", c: null, a: 3, r: 0, id: "t2", url: "/t/t2" },
    { t: "skipped", n: "A031", c: 1, a: 0, r: 0, id: "t3", url: "/t/t3" },
  ];
  for (const [i, p] of payloads.entries()) {
    await deliver(p);
    await expect.poll(count, { timeout: 10_000 }).toBe(i + 1);
  }
  await expect
    .poll(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}｜${n.body}`))).sort(), { timeout: 10_000 })
    .toEqual(["A031 已過號｜請洽櫃台人員", "快輪到您了｜A030 前面還有 3 位，請回到店內留意叫號", "輪到您了！A023｜請到 2 號櫃台"]);
  const called = await page.evaluate(async () => {
    const n = (await (await navigator.serviceWorker.ready).getNotifications()).find((x) => x.title.startsWith("輪到您了"))!;
    return { requireInteraction: n.requireInteraction, tag: n.tag, data: n.data };
  });
  expect(called).toMatchObject({ requireInteraction: true, tag: "qcs-t1", data: { url: "/t/t1" } });
  await ctx.close();
});

test("2.1／2.3 權限被拒：照常取號，號碼頁提示保持頁面開啟", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const deny = `Notification.requestPermission = async () => 'denied'; Object.defineProperty(Notification, 'permission', { get: () => 'denied' });`;
  const customer = await takeViaUi(browser, url, "拒絕通知", "0955000003", PHONE, deny);
  await expect(customer.getByTestId("push-denied")).toBeVisible();
  await expect(customer.getByTestId("keep-open")).toContainText("請保持此頁開啟");
  await shot(customer, "notify-04-push-denied");
  await customer.getByRole("button", { name: "取消號碼" }).click();
  await customer.getByRole("button", { name: "確定取消" }).click();
  await customer.context().close();
  await display.context().close();
});

test("2.3 iOS：Safari 號碼頁顯示加入主畫面教學＋轉交碼 → 主畫面 app 輸入轉交碼取回號碼 → 可開啟背景提醒", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const ios = { ...PHONE, userAgent: IPHONE_UA };
  const safari = await takeViaUi(browser, url, "蘋果用戶", "0955000004", ios);
  const number = (await safari.getByTestId("my-number").textContent())!.trim();
  await expect(safari.getByTestId("ios-guide")).toBeVisible();
  await expect(safari.getByTestId("enable-push")).toHaveCount(0); // Safari 分頁沒有推播：只給教學
  await expect(safari.getByText("正在開啟背景提醒")).toHaveCount(0); // 回歸（N1）：Safari 分頁不請求推播、不顯示卡住的「開啟中」
  await shot(safari, "notify-05-ios-guide", true);
  await safari.getByTestId("show-xfer").click();
  const code = ((await safari.getByTestId("xfer-code").textContent()) ?? "").replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);
  await shot(safari, "notify-06-ios-xfer-code", true);
  expect(await layoutIssues(safari)).toEqual([]);

  // 主畫面 app（standalone，storage 與 Safari 不共用）
  const app = await browser.newContext({ ...ios });
  await app.addInitScript({ content: "Object.defineProperty(navigator, 'standalone', { get: () => true });" });
  const home = await app.newPage();
  await home.goto(URLS.customer + "/resume");
  await home.getByTestId("xfer-input").waitFor();
  await shot(home, "notify-07-resume");
  await home.getByTestId("xfer-input").fill("000000");
  await home.getByTestId("xfer-submit").click();
  await expect(home.getByRole("alert")).toContainText("轉交碼錯誤或已過期");
  await shot(home, "notify-08-resume-error");
  await home.getByTestId("xfer-input").fill(code);
  await home.getByTestId("xfer-submit").click();
  await expect(home.getByTestId("my-number")).toHaveText(number);
  await expect(home.getByTestId("ios-guide")).toHaveCount(0); // 已在主畫面 app：不再顯示教學
  await expect(home.getByTestId("enable-push")).toBeVisible();
  await shot(home, "notify-09-standalone-ticket");
  // 同一個轉交碼不能再用
  const again = await fetch(`${URLS.api}/api/transfer/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(again.status).toBe(404);
  await home.getByRole("button", { name: "取消號碼" }).click();
  await home.getByRole("button", { name: "確定取消" }).click();
  await app.close();
  await safari.context().close();
  await display.context().close();
});

test("M2 360×640：號碼頁提醒卡、iOS 教學、轉交碼輸入頁完整可操作", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const t: any = await apiTake(url, "小螢幕", "0955000005");
  expect(t.ticket?.number).toBeTruthy();
  for (const [name, ua] of [["android", PHONE.userAgent!], ["ios", IPHONE_UA]] as const) {
    const ctx = await browser.newContext({ ...SMALL, userAgent: ua });
    await ctx.addInitScript({ content: `localStorage.setItem("qcs.customer.ticket", ${JSON.stringify(JSON.stringify({ token: t.ticketToken, ticketId: t.ticket.id, store: t.store }))});` });
    const p = await ctx.newPage();
    await p.goto(URLS.customer + "/");
    await p.getByTestId("notify-card").waitFor();
    await shot(p, `small-notify-${name}-ticket`, true);
    expect(await layoutIssues(p)).toEqual([]);
    await ctx.close();
  }
  const r = await browser.newContext(SMALL);
  const rp = await r.newPage();
  await rp.goto(URLS.customer + "/resume");
  await rp.getByTestId("xfer-input").waitFor();
  await shot(rp, "small-notify-resume");
  expect(await layoutIssues(rp)).toEqual([]);
  await r.close();
  await fetch(`${URLS.api}/api/tickets/${t.ticket.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${t.ticketToken}` } });
  await display.context().close();
});

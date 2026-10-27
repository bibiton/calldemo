import { expect, test } from "@playwright/test";
import { PHONE, SMALL, URLS, openDisplay, qrTokenFor, qrUrl, seed, shot, staffLogin, takeTicket } from "./helpers";

test.describe.configure({ mode: "serial" });

test("1.10 主流程：掃碼取號 → 人員叫號 → 面板顯示＋音訊播放 → 顧客頁更新", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  await expect(display.getByRole("heading", { name: s.name })).toBeVisible();
  const url = await qrUrl(display);
  expect(url).toMatch(new RegExp(`^http://localhost:6175/s/${s.code}\\?w=\\d+&k=[A-Z2-7]{10}$`));
  await shot(display, "display-01-idle");

  // 顧客：掃碼（開 QR 網址）→ 選服務 → 填資料 → 取號
  const customer = await takeTicket(browser, url, "王小明", "0912-345-678", PHONE, "customer");
  const number = (await customer.getByTestId("my-number").textContent())!.trim();
  expect(number).toBe("A001");
  await expect(customer.getByTestId("ahead")).toHaveText("0");
  await shot(customer, "customer-04-ticket");
  await expect(display.getByTestId("waiting")).toContainText("1");

  // 人員：登入 → 叫下一號
  const staff = await staffLogin(browser, s, PHONE, "staff");
  await expect(staff.getByTestId("waiting-list")).toContainText("王小明");
  await shot(staff, "staff-04-desk-waiting");

  // 先等廣告輪到影片（第 2 張）且正在播放，才能驗證「叫號時影片靜音暫停」
  const video = display.getByTestId("ad-video");
  await video.waitFor({ timeout: 15_000 });
  await display.waitForFunction(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="ad-video"]');
    return !!v && !v.paused && v.currentTime > 0.3;
  });
  const t0 = Date.now();
  await staff.getByTestId("call-next").click();

  // 面板大字＝該號、櫃台、播放佇列收到 1 筆（叮咚開頭、號碼 A1、櫃台 1）
  await expect(display.getByTestId("current-number")).toHaveText(number);
  const latency = Date.now() - t0;
  expect(latency).toBeLessThan(1000); // UX 底線：按下到面板出現 < 1 秒
  await expect(display.getByTestId("current-counter")).toHaveText("請到 1 號櫃台");
  await display.waitForFunction((n) => (window.__qcsAudioLog ?? []).some((e) => e.type === "start" && e.number === n), number);
  const ad = await display.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="ad-video"]');
    return v ? { paused: v.paused, muted: v.muted, t: v.currentTime } : null;
  });
  if (ad) expect(ad).toMatchObject({ paused: true, muted: true });
  await shot(display, "display-02-called");

  // 顧客頁：全螢幕叫號提示
  await expect(customer.getByTestId("called-alert")).toBeVisible();
  await expect(customer.getByTestId("called-alert")).toContainText("請到 1 號櫃台");
  // 回歸（C1）：提醒層整層不透明，下層文字不透出
  const op = await customer.getByTestId("called-alert").evaluate((el) => getComputedStyle(el).opacity);
  expect(op).toBe("1");
  await shot(customer, "customer-05-called-alert");
  await expect(staff.getByTestId("current-number")).toHaveText(number);
  await shot(staff, "staff-05-desk-called");

  // 播放結束：佇列 1 筆、不重疊、片段依 manifest；廣告恢復續播
  await display.waitForFunction((n) => (window.__qcsAudioLog ?? []).some((e) => e.type === "end" && e.number === n), number, { timeout: 20_000 });
  const log = await display.evaluate(() => window.__qcsAudioLog!);
  const starts = log.filter((e) => e.type === "start" && e.number !== "");
  expect(starts.length).toBe(1);
  expect(starts[0].keys[0]).toMatch(/^chime\./);
  expect(starts[0].keys).toContain("number.A.1");
  expect(starts[0].keys).toContain("counter.1");
  expect(starts[0].keys.filter((k) => k === "number.A.1").length).toBe(2); // ×2
  if (ad) {
    await display.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="ad-video"]');
      return !v || !v.paused;
    });
    const after = await display.evaluate(() => document.querySelector<HTMLVideoElement>('[data-testid="ad-video"]')?.currentTime ?? -1);
    if (after >= 0) expect(after).toBeGreaterThanOrEqual(ad.t - 0.05); // 從暫停處續播
  }

  // 重叫 → 面板再播一次（重叫句型）
  await staff.getByTestId("act-recall").click();
  await display.waitForFunction(() => (window.__qcsAudioLog ?? []).filter((e) => e.type === "start" && e.kind === "recall").length === 1);
  const recall = (await display.evaluate(() => window.__qcsAudioLog!)).find((e) => e.type === "start" && e.kind === "recall")!;
  expect(recall.keys[1]).toMatch(/^phrase\.recall/);

  // 完成 → 顧客頁顯示完成
  await customer.getByRole("button", { name: "我知道了" }).click();
  await staff.getByTestId("act-finish").click();
  await expect(customer.getByTestId("ticket")).toHaveAttribute("data-status", "done");
  await shot(customer, "customer-06-done");
  await expect(display.getByTestId("recent")).toBeVisible();
});

test("連續叫 3 號：面板依序播放不重疊、近期叫號列出", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  for (const [i, n] of ["林大華", "陳美玲", "張志明"].entries()) await takeTicket(browser, url, n, `09220000${i}${i}`);
  const staff = await staffLogin(browser, s);
  await display.evaluate(() => (window.__qcsAudioLog = []));
  for (let i = 0; i < 3; i++) {
    await staff.getByTestId("call-next").click();
    await expect(staff.getByTestId("call-next")).toHaveText("叫下一號");
  }
  await display.waitForFunction(() => (window.__qcsAudioLog ?? []).filter((e) => e.type === "end").length >= 3, null, { timeout: 45_000 });
  const log = await display.evaluate(() => window.__qcsAudioLog!.filter((e) => e.number));
  const seq = log.map((e) => `${e.type}:${e.number}`);
  expect(seq).toEqual(["start:A002", "end:A002", "start:A003", "end:A003", "start:A004", "end:A004"]);
  await expect(display.getByTestId("current-number")).toHaveText("A004");
  await expect(display.getByTestId("recent")).toContainText("A003");
  await expect(display.getByTestId("recent")).toContainText("A002");
  // 回歸（D4）：近期叫號＋等候卡不得溢出畫面
  const fit = await display.evaluate(() => {
    const w = document.querySelector('[data-testid="waiting"]')!.getBoundingClientRect();
    const box = document.querySelector<HTMLElement>('[data-testid="bottom-left"]')!;
    return { waitingBottom: w.bottom, vh: innerHeight, overflow: box.scrollHeight - box.clientHeight };
  });
  expect(fit.waitingBottom).toBeLessThanOrEqual(fit.vh);
  expect(fit.overflow).toBeLessThanOrEqual(0);
  await shot(display, "display-03-after-3-calls");
  await shot(staff, "staff-06-after-3-calls");
});

test("人員端：轉櫃台 sheet、代客取號、按住顯示完整手機", async ({ browser }) => {
  const s = seed("DEMO01");
  const staff = await staffLogin(browser, s);
  await staff.getByTestId("create-open").click();
  await shot(staff, "staff-07-create-sheet");
  await staff.getByPlaceholder("姓名（選填）").fill("代取先生");
  await staff.getByPlaceholder("手機（選填）").fill("0933111222");
  await staff.getByRole("button", { name: "取號", exact: true }).click();
  await expect(staff.getByTestId("toast")).toContainText("已取號 A005");
  const tb = (await staff.getByTestId("toast").boundingBox())!;
  const cb = (await staff.getByTestId("current").boundingBox())!;
  expect(tb.y).toBeGreaterThan(cb.y + cb.height); // 回歸（S2）：toast 不蓋住目前號碼
  await staff.getByTestId("call-next").click();
  await expect(staff.getByTestId("current-number")).toHaveText("A005");
  await expect(staff.getByTestId("current")).toContainText("0933***222");
  const eye = staff.getByTestId("reveal");
  const box = (await eye.boundingBox())!;
  await staff.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await staff.mouse.down();
  await expect(staff.getByTestId("current")).toContainText("0933111222");
  await shot(staff, "staff-08-reveal-phone");
  await staff.mouse.up();
  await expect(staff.getByTestId("current")).toContainText("0933***222");
  await staff.getByTestId("act-transfer").click();
  await shot(staff, "staff-09-transfer-sheet");
  await staff.getByRole("button", { name: "2 號櫃台" }).click();
  await expect(staff.getByTestId("current")).toContainText("尚未叫號");
});

test("顧客頁：重複取號、錯誤格式、過期 QR 的提示", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByTestId("service-A").click();
  await page.getByTestId("name").fill("王小明");
  await page.getByTestId("phone").fill("0812345678");
  await page.getByTestId("phone").blur();
  await expect(page.getByText("請輸入台灣手機號碼")).toBeVisible();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("consent-hint")).toBeVisible(); // 回歸（C3）
  await shot(page, "customer-07-validation");
  // 竄改 window（token 對不上）→ 無效
  const u = new URL(url);
  const w = Number(u.searchParams.get("w"));
  u.searchParams.set("w", String(w - 2));
  const p1 = await (await browser.newContext(PHONE)).newPage();
  await p1.goto(u.toString());
  await expect(p1.getByText("QR Code 無效")).toBeVisible();
  // 真實的 window-2 token → 過期
  u.searchParams.set("k", qrTokenFor(s.id, w - 2));
  const p2 = await (await browser.newContext(PHONE)).newPage();
  await p2.goto(u.toString());
  await expect(p2.getByText("QR Code 已過期")).toBeVisible();
  await shot(p2, "customer-08-qr-expired");
  // 同手機同姓名再掃一次（新裝置、新 session）→ 帶回原號碼
  const first = await takeTicket(browser, url, "周杰", "0977000222");
  const firstNo = await first.getByTestId("my-number").textContent();
  const again = await takeTicket(browser, url, "周杰", "0977000222");
  await expect(again.getByText("您已有號碼")).toBeVisible();
  await expect(again.getByTestId("my-number")).toHaveText(firstNo!);
  await shot(again, "customer-10-existing-ticket");
  // 同手機不同姓名 → 請洽櫃台
  const ctx4 = await browser.newContext(PHONE);
  const p4 = await ctx4.newPage();
  await p4.goto(url);
  await p4.getByTestId("service-A").click();
  await p4.getByTestId("name").fill("別人");
  await p4.getByTestId("phone").fill("0977000222");
  await p4.getByTestId("consent").check();
  await p4.getByTestId("submit").click();
  await expect(p4.getByRole("alert")).toContainText("此手機已有進行中號碼，請洽櫃台");
  await shot(p4, "customer-11-phone-active");
  // 沒有 QR 參數
  const p3 = await (await browser.newContext(PHONE)).newPage();
  await p3.goto(`${URLS.customer}/`);
  await expect(p3.getByText("請掃描 QR Code 取號")).toBeVisible();
  await shot(p3, "customer-09-no-qr");
});

test("360×640 最小尺寸：顧客取號與人員端可完整操作", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const url = await qrUrl(display);
  const c = await takeTicket(browser, url, "歐陽小明", "0955000111", SMALL, "small-customer");
  await shot(c, "small-customer-04-ticket");
  const st = await staffLogin(browser, s, SMALL, "small-staff");
  await shot(st, "small-staff-04-desk");
  const nav = await st.getByRole("navigation", { name: "叫號操作" }).boundingBox();
  expect(nav!.y + nav!.height).toBeLessThanOrEqual(640);
  for (const id of ["act-recall", "act-skip", "act-noshow", "act-transfer", "act-serve", "act-finish", "call-next"]) {
    const b = (await st.getByTestId(id).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  const scrollW = await st.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(360);
});

test("面板版面量測：QR ≥ 38% 寬、在最上層不被遮、與廣告不重疊；叫號大字 ≥ 240px", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  await qrUrl(display);
  const m = await display.evaluate(() => {
    const svg = document.querySelector('[data-testid="qr-panel"] svg')!.getBoundingClientRect();
    const ad = document.querySelector('[data-testid="ad-area"]')!.getBoundingClientRect();
    const num = document.querySelector('[data-testid="current-number"]')!;
    const cx = svg.left + svg.width / 2;
    const cy = svg.top + svg.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const corners = [
      [svg.left + 2, svg.top + 2],
      [svg.right - 2, svg.bottom - 2],
    ].map(([x, y]) => document.querySelector('[data-testid="qr-panel"]')!.contains(document.elementFromPoint(x, y)));
    return {
      qrW: svg.width,
      qrBodyRatio: (svg.width * (33 / 41)) / window.innerWidth,
      overlapAd: !(svg.top >= ad.bottom || svg.bottom <= ad.top || svg.left >= ad.right || svg.right <= ad.left),
      topIsQr: !!top && document.querySelector('[data-testid="qr-panel"]')!.contains(top),
      corners,
      fontPx: parseFloat(getComputedStyle(num).fontSize),
      adAspect: ad.width / ad.height,
      scrollH: document.documentElement.scrollHeight,
    };
  });
  expect(m.qrBodyRatio).toBeGreaterThanOrEqual(0.38);
  expect(m.overlapAd).toBe(false);
  expect(m.topIsQr).toBe(true);
  expect(m.corners).toEqual([true, true]);
  expect(m.fontPx).toBeGreaterThanOrEqual(240);
  expect(m.adAspect).toBeCloseTo(1.5, 1);
  expect(m.scrollH).toBeLessThanOrEqual(1920);
});

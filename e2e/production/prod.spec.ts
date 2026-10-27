import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 正式網址 E2E：顧客掃面板 QR 取號 → 人員叫號 → 面板顯示＋音訊事件 → 顧客頁更新；門店後台；總後台（Access）；模擬叫號。 */
const OUT = resolve(import.meta.dirname, "../../test-results/production");
mkdirSync(OUT, { recursive: true });
const FILE = resolve(homedir(), ".config/queue-call-system/demo-output.json");
test.skip(!existsSync(FILE), "需要先執行 pnpm seed:demo --env production --confirm");
const demo = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { stores: [] };
const store = (code: string) => demo.stores.find((s: any) => s.code === code);
const TV: BrowserContextOptions = { viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};
const shot = async (p: Page, name: string, fullPage = false) => {
  await p.waitForTimeout(400);
  await p.screenshot({ path: resolve(OUT, `${name}.png`), fullPage });
};
const open = async (b: Browser, opts: BrowserContextOptions, url: string) => {
  const page = await (await b.newContext(opts)).newPage();
  await page.goto(url);
  return page;
};
const issues = (p: Page) =>
  p.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`水平溢出 ${document.documentElement.scrollWidth}`);
    const t = document.body.innerText;
    for (const w of ["NaN", "undefined", "[object Object]"]) if (t.includes(w)) out.push(`出現 ${w}`);
    for (const img of Array.from(document.images)) if (img.complete && img.naturalWidth === 0 && img.getBoundingClientRect().width > 0) out.push(`破圖 ${img.src}`);
    return out;
  });

test.describe.configure({ mode: "serial" });

test("正式網址主流程（台中公益店）：面板 QR → 顧客取號 → 人員叫號 → 面板大字＋音訊 → 顧客頁更新", async ({ browser }) => {
  const s = store("DEMOSK02");
  const display = await open(browser, TV, s.devices.displayUrl);
  await display.getByTestId("board").waitFor();
  await expect(display.getByRole("heading", { name: s.name })).toBeVisible();
  await expect(display.getByText("DEMO・虛構品牌")).toBeVisible();
  const qr = display.getByTestId("qr-panel");
  await qr.locator("svg").waitFor();
  const url = (await qr.getAttribute("data-qr-url"))!;
  expect(url).toMatch(/^https:\/\/call-q\.jjoy\.ai\/s\/DEMOSK02\?w=\d+&k=[A-Z2-7]{10}$/);
  // 等廣告開始輪播（圖片從 call-media 載入）
  await display.locator("[data-testid=ad-area][data-ad-kind]").waitFor({ timeout: 30_000 });
  await display.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>("[data-testid=ad-area] img")).some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30_000 });
  await shot(display, "prod-display-01-idle");
  expect(await issues(display)).toEqual([]);

  // 顧客：開面板 QR 的網址
  const customer = await open(browser, PHONE, url);
  await customer.getByTestId("service-A").waitFor();
  await shot(customer, "prod-customer-01-service");
  await customer.getByTestId("service-A").click();
  await customer.getByTestId("name").fill("測試顧客");
  await customer.getByTestId("phone").fill(`09${String(Date.now()).slice(-8)}`);
  await customer.getByTestId("consent").check();
  await shot(customer, "prod-customer-02-form");
  await customer.getByTestId("submit").click();
  await customer.getByTestId("my-number").waitFor();
  const number = (await customer.getByTestId("my-number").textContent())!.trim();
  expect(number).toMatch(/^A\d{3}$/);
  await shot(customer, "prod-customer-03-ticket");
  expect(await issues(customer)).toEqual([]);

  // 人員：選人 → PIN → 櫃台 1 → 叫下一號（佇列裡可能有更早的號碼：叫到自己的號為止）
  const staff = await open(browser, PHONE, s.devices.staffUrl);
  const me = s.staff[0];
  await staff.getByTestId(`staff-${me.id}`).click();
  for (const d of me.pin) await staff.getByTestId(`pin-${d}`).click();
  await staff.getByTestId("counter-1").click();
  await staff.getByTestId("call-next").waitFor();
  await staff.waitForFunction(() => !document.querySelector('[data-testid="offline"]'));
  await shot(staff, "prod-staff-01-desk");
  let t0 = 0;
  for (let i = 0; i < 20; i++) {
    t0 = Date.now();
    await staff.getByTestId("call-next").click();
    await expect(staff.getByTestId("current-number")).not.toHaveText("", { timeout: 10_000 });
    if ((await staff.getByTestId("current-number").textContent())!.trim() === number) break;
    await staff.waitForTimeout(300);
  }
  await expect(display.getByTestId("current-number")).toHaveText(number);
  const latency = Date.now() - t0;
  await expect(display.getByTestId("current-counter")).toContainText("1 號櫃台");
  await display.waitForFunction((n) => (window as any).__qcsAudioLog?.some((e: any) => e.type === "start" && e.number === n), number, { timeout: 20_000 });
  const start = await display.evaluate((n) => (window as any).__qcsAudioLog.find((e: any) => e.type === "start" && e.number === n), number);
  expect(start.keys[0]).toMatch(/^chime\./);
  await shot(display, "prod-display-02-called");
  await expect(customer.getByTestId("called-alert")).toBeVisible();
  await shot(customer, "prod-customer-04-called-alert");
  await shot(staff, "prod-staff-02-called");
  await display.waitForFunction((n) => (window as any).__qcsAudioLog?.some((e: any) => e.type === "end" && e.number === n), number, { timeout: 30_000 });
  console.log(`叫號 → 面板大字：${latency} ms；音訊片段：${start.keys.join(" ")}`);

  await customer.getByRole("button", { name: "我知道了" }).click();
  await staff.getByTestId("act-finish").click();
  await expect(customer.getByTestId("ticket")).toHaveAttribute("data-status", "done");
  await shot(customer, "prod-customer-05-done");
});

test("正式網址：門店後台（台中公益店）登入、即時隊列、廣告、裝置", async ({ browser }) => {
  const s = store("DEMOSK02");
  const page = await open(browser, PHONE, "https://call-store.jjoy.ai/");
  await page.getByTestId("email").fill(s.adminEmail);
  await page.getByTestId("password").fill(s.adminPassword);
  await shot(page, "prod-store-01-login");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("board").waitFor();
  await shot(page, "prod-store-02-board");
  expect(await issues(page)).toEqual([]);
  for (const [path, name] of [["/ads", "prod-store-03-ads"], ["/devices", "prod-store-04-devices"], ["/reports", "prod-store-05-reports"]]) {
    await page.goto(`https://call-store.jjoy.ai${path}`);
    await page.waitForLoadState("networkidle");
    await shot(page, name, true);
    expect(await issues(page)).toEqual([]);
  }
});

test("正式網址：顧客手機頁的 Logo／主視覺／DEMO 標示（台北中山店）", async ({ browser }) => {
  const s = store("DEMOSK01");
  const display = await open(browser, TV, s.devices.displayUrl);
  await display.getByTestId("qr-panel").locator("svg").waitFor();
  const url = (await display.getByTestId("qr-panel").getAttribute("data-qr-url"))!;
  const customer = await open(browser, PHONE, url);
  await customer.getByTestId("service-A").waitFor();
  await customer.waitForLoadState("networkidle");
  await expect(customer.getByText("DEMO・虛構品牌").first()).toBeVisible();
  await shot(customer, "prod-customer-zs-01-home");
  expect(await issues(customer)).toEqual([]);
});

test("正式網址：模擬叫號（台北中山店）—面板自動出現叫號與語音事件", async ({ browser }) => {
  const s = store("DEMOSK01");
  const display = await open(browser, TV, s.devices.displayUrl);
  await display.getByTestId("board").waitFor();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  test.skip(hour < 10 || hour >= 22, "模擬叫號只在營業時間 10:00–22:00");
  await display.waitForFunction(() => (window as any).__qcsAudioLog?.some((e: any) => e.type === "start" && e.number), null, { timeout: 75_000 });
  await expect(display.getByTestId("current-number")).not.toHaveText("");
  await shot(display, "prod-display-zs-simulated");
});

test("正式網址：總後台受 Cloudflare Access 保護（自動化只截到登入頁）", async ({ browser }) => {
  const page = await open(browser, PHONE, "https://call-admin.jjoy.ai/");
  await page.waitForURL(/cloudflareaccess\.com/);
  await expect(page.getByText("Send login code")).toBeVisible();
  await shot(page, "prod-admin-01-access-login");
  const r = await page.request.get("https://call-api.jjoy.ai/api/admin/me");
  expect(r.status()).toBe(401);
});

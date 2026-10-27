import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";

export const ROOT = resolve(import.meta.dirname, "..");
export const SHOTS = resolve(ROOT, "test-results/visual");
export const URLS = { display: "http://localhost:6174", customer: "http://localhost:6175", staff: "http://localhost:6173", api: "http://127.0.0.1:8788" };

export interface SeedStore {
  id: string;
  code: string;
  name: string;
  displayToken: string;
  staffDeviceToken: string;
  staff: { id: string; name: string; pin: string }[];
}
export function seed(code = "DEMO01"): SeedStore {
  const s = JSON.parse(readFileSync(resolve(ROOT, ".e2e-state/seed-output.json"), "utf8"));
  return s.stores.find((x: SeedStore) => x.code === code);
}

/** 直立電視 1080×1920 */
export const TV: BrowserContextOptions = { viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 };
/** 手機直版 390×844（Chromium 模擬，含觸控） */
export const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};
/** 最小支援尺寸 360×640（00-principles 檢查表） */
export const SMALL: BrowserContextOptions = { ...PHONE, viewport: { width: 360, height: 640 } };

export async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });
}

export async function openDisplay(browser: Browser, s: SeedStore, extra: BrowserContextOptions = {}) {
  const ctx = await browser.newContext({ ...TV, ...extra });
  const page = await ctx.newPage();
  await page.goto(`${URLS.display}/?token=${s.displayToken}`);
  await page.getByTestId("board").waitFor();
  return page;
}

export async function qrUrl(display: Page): Promise<string> {
  const panel = display.getByTestId("qr-panel");
  await panel.locator("svg").waitFor();
  return (await panel.getAttribute("data-qr-url"))!;
}

export async function staffLogin(browser: Browser, s: SeedStore, opts: BrowserContextOptions = PHONE, shots?: string) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(`${URLS.staff}/?device=${s.staffDeviceToken}`);
  await page.getByTestId(`staff-${s.staff[0].id}`).waitFor();
  if (shots) await shot(page, `${shots}-01-pick-staff`);
  await page.getByTestId(`staff-${s.staff[0].id}`).click();
  if (shots) await shot(page, `${shots}-02-pin`);
  for (const d of s.staff[0].pin) await page.getByTestId(`pin-${d}`).click();
  await page.getByTestId("counter-1").waitFor();
  if (shots) await shot(page, `${shots}-03-counter`);
  await page.getByTestId("counter-1").click();
  await page.getByTestId("call-next").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="offline"]'));
  return page;
}

export async function takeTicket(browser: Browser, url: string, name: string, phone: string, opts: BrowserContextOptions = PHONE, shots?: string) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByTestId("service-A").waitFor();
  if (shots) await shot(page, `${shots}-01-service`);
  await page.getByTestId("service-A").click();
  await page.getByTestId("name").waitFor();
  if (shots) await shot(page, `${shots}-02-form-empty`);
  await page.getByTestId("name").fill(name);
  await page.getByTestId("phone").fill(phone);
  await page.getByTestId("consent").check();
  await page.getByRole("button", { name: "查看說明" }).click();
  if (shots) await shot(page, `${shots}-03-form-filled`);
  await page.getByTestId("submit").click();
  await page.getByTestId("my-number").waitFor();
  return page;
}

/** 以本機 .dev.vars 的 QR_ROOT_SECRET 算出指定 window 的真實 token（測「過期」用）。 */
export function qrTokenFor(storeId: string, w: number): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const vars = readFileSync(resolve(ROOT, "apps/api/.dev.vars"), "utf8");
  const root = /QR_ROOT_SECRET=(.*)/.exec(vars)![1].trim();
  const key = createHmac("sha256", root).update(`${storeId}:1`).digest();
  const mac = createHmac("sha256", key).update(`${storeId}:${w}`).digest();
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const b of mac) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 10);
}

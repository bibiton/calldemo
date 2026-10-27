/**
 * 顧客手機圖片（ADR-048）：頁首 Logo（失敗退回店名）、取號頁主視覺（送出鈕仍在首屏）、號碼頁圖片輪播
 * （號碼與前面幾位仍在首屏最上方、輪播不跑版、無圖時版面正常、圖片讀取失敗不出現破圖、叫號提醒蓋過輪播），
 * 門店後台「顯示於顧客手機」勾選與手機預覽。390×844 與 360×640。
 * 取號用 DEMO04（其他 spec 不用；main-flow 需要 DEMO01 當日第一號是 A001）。
 */
import { expect, test, type Page } from "@playwright/test";
import { PHONE, SMALL, URLS, layoutIssues, openDisplay, qrUrl, seed, shot, staffLogin, storeLogin } from "./helpers";

test.describe.configure({ mode: "serial" });

/** 畫面上看得到、但沒載入成功的圖片（破圖）。 */
const brokenImages = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.images).filter((im) => {
      const r = im.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(im).opacity !== "0";
      return visible && im.complete && im.naturalWidth === 0;
    }).length,
  );

const inFirstScreen = async (page: Page, testId: string) => {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return b.y >= 0 && b.y + b.height <= (page.viewportSize()?.height ?? 0);
};

test("門店後台：圖片勾選「顯示於顧客手機」＋手機預覽；影片沒有這個選項", async ({ browser }) => {
  const s = seed("DEMO04");
  const page = await storeLogin(browser, s);
  await page.getByTestId("tab-廣告").click();
  await page.getByTestId("ad-item").first().waitFor();
  await expect(page.getByTestId("phone-preview")).toContainText("顯示於顧客手機");
  for (const i of [0, 2]) {
    await page.getByTestId(`edit-${i}`).click();
    await page.getByTestId("show-on-customer").click();
    await page.getByTestId("save").click();
    await expect(page.getByTestId("edit-sheet")).toHaveCount(0);
  }
  // 第 2 項是影片：沒有勾選、顯示說明
  await page.getByTestId("edit-1").click();
  await expect(page.getByTestId("show-on-customer")).toHaveCount(0);
  await expect(page.getByTestId("edit-sheet")).toContainText("不會出現在顧客手機");
  await shot(page, "store-42-ad-video-no-customer");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("phone-preview")).toContainText("2 張圖片輪播中");
  await expect(page.getByTestId("ad-item").first()).toContainText("顧客手機");
  await page.waitForTimeout(2800); // 等「已儲存」提示消失
  await page.getByTestId("phone-preview").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, -80));
  await shot(page, "store-43-ads-phone-preview");
  expect(await layoutIssues(page)).toEqual([]);
  await page.context().close();
});

for (const [opts, pre] of [
  [PHONE, "custimg"],
  [SMALL, "small-custimg"],
] as const) {
  test(`顧客頁圖片（${pre}）：Logo、主視覺、號碼頁輪播、叫號提醒蓋過`, async ({ browser }) => {
    // Logo（DEMO01 只開 session，不取號）
    const zs = seed("DEMO01");
    const d1 = await openDisplay(browser, zs);
    const c1 = await (await browser.newContext(opts)).newPage();
    await c1.goto(await qrUrl(d1));
    await c1.getByTestId("store-logo").waitFor();
    await expect.poll(() => c1.evaluate(() => document.querySelector<HTMLImageElement>('[data-testid="store-logo"] img')!.naturalWidth)).toBeGreaterThan(0);
    await c1.getByTestId("service-A").click();
    await c1.getByTestId("name").waitFor();
    await expect(c1.getByTestId("hero")).toBeVisible();
    expect(await inFirstScreen(c1, "submit"), "送出鈕在首屏").toBe(true);
    expect(await inFirstScreen(c1, "name"), "姓名欄在首屏").toBe(true);
    expect(await brokenImages(c1)).toBe(0);
    expect(await layoutIssues(c1)).toEqual([]);
    await shot(c1, `${pre}-01-form-logo-hero`);
    await c1.context().close();
    await d1.context().close();

    // 取號 → 號碼頁輪播（DEMO04，前一個 test 已勾選 2 張）
    const s = seed("DEMO04");
    const display = await openDisplay(browser, s);
    const url = await qrUrl(display);
    const page = await (await browser.newContext(opts)).newPage();
    await page.goto(url);
    await expect(page.getByTestId("store-name")).toContainText("新莊店"); // 沒有 Logo → 店名
    await page.getByTestId("service-A").click();
    await page.getByTestId("name").fill("林小美");
    await page.getByTestId("phone").fill(pre === "custimg" ? "0911000111" : "0911000222");
    await page.getByTestId("consent").check();
    expect(await inFirstScreen(page, "submit")).toBe(true);
    await page.getByTestId("submit").click();
    await page.getByTestId("my-number").waitFor();
    const car = page.getByTestId("carousel");
    await car.waitFor();
    expect(await inFirstScreen(page, "my-number"), "號碼在首屏").toBe(true);
    expect(await inFirstScreen(page, "ahead"), "前面幾位在首屏").toBe(true);
    const tk = (await page.getByTestId("ticket").boundingBox())!;
    const cb = (await car.boundingBox())!;
    expect(cb.y, "輪播在號碼卡下方").toBeGreaterThanOrEqual(tk.y + tk.height);
    expect(Math.abs(cb.width / (cb.height - 22) - 1.5), "輪播 3:2（扣掉指示點列）").toBeLessThan(0.08);
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="carousel"] img')).filter((i) => i.naturalWidth > 0).length)).toBeGreaterThan(0);
    expect(await brokenImages(page)).toBe(0);
    expect(await layoutIssues(page)).toEqual([]);
    expect(await page.evaluate(() => scrollY), "號碼頁從頂端開始").toBe(0);
    expect(await inFirstScreen(page, "my-number"), "圖片載入後號碼仍在首屏").toBe(true);
    await shot(page, `${pre}-02-ticket-carousel`);
    await shot(page, `${pre}-02-ticket-carousel-full`, true);

    // 叫號：全螢幕提醒蓋過輪播
    const staff = await staffLogin(browser, s);
    await staff.getByTestId("call-next").click();
    await page.getByTestId("called-alert").waitFor();
    const top = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="carousel"]')?.getBoundingClientRect();
      if (!r) return "no-carousel";
      const el = document.elementFromPoint(r.x + r.width / 2, Math.min(innerHeight - 2, r.y + r.height / 2));
      return el?.closest('[data-testid="called-alert"]') ? "alert" : el?.outerHTML.slice(0, 80);
    });
    expect(["alert", "no-carousel"]).toContain(top);
    await shot(page, `${pre}-03-called-over-carousel`);
    await staff.context().close();
    await page.context().close();
    await display.context().close();
  });
}

test("圖片讀取失敗：輪播移除壞圖、全部失敗則整塊不顯示；Logo 失敗退回店名；無破圖", async ({ browser }) => {
  const zs = seed("DEMO01");
  const d1 = await openDisplay(browser, zs);
  const ctx = await browser.newContext(PHONE);
  await ctx.route("**/demo-ads/**", (r) => r.fulfill({ status: 404, body: "" }));
  const page = await ctx.newPage();
  await page.goto(await qrUrl(d1));
  await page.getByTestId("store-name").waitFor(); // Logo 失敗 → 店名
  await page.getByTestId("service-A").click();
  await page.getByTestId("name").waitFor();
  await expect(page.getByTestId("hero")).toHaveCount(0);
  expect(await brokenImages(page)).toBe(0);
  await shot(page, "custimg-04-images-failed");
  await ctx.close();

  // 號碼頁：用 DEMO04 已取的號碼（localStorage 由同一 context 保存）→ 直接驗證輪播元件在所有圖失敗時不顯示
  const s = seed("DEMO04");
  const display = await openDisplay(browser, s);
  const c2 = await browser.newContext(SMALL);
  await c2.route("**/ads/**", (r) => r.fulfill({ status: 404, body: "" }));
  await c2.route("**/demo-ads/**", (r) => r.fulfill({ status: 404, body: "" }));
  const p2 = await c2.newPage();
  await p2.goto(await qrUrl(display));
  await p2.getByTestId("service-A").click();
  await p2.getByTestId("name").fill("陳小華");
  await p2.getByTestId("phone").fill("0911000333");
  await p2.getByTestId("consent").check();
  await p2.getByTestId("submit").click();
  await p2.getByTestId("my-number").waitFor();
  await expect(p2.getByTestId("carousel")).toHaveCount(0);
  expect(await brokenImages(p2)).toBe(0);
  expect(await layoutIssues(p2)).toEqual([]);
  await shot(p2, "small-custimg-05-ticket-images-failed");
  await c2.close();
  await d1.context().close();
  await display.context().close();
});

test("沒有勾選任何圖片的門店：沒有主視覺、沒有輪播，版面與之前相同", async ({ browser }) => {
  const s = seed("DEMO02");
  const display = await openDisplay(browser, s);
  const page = await (await browser.newContext(SMALL)).newPage();
  await page.goto(await qrUrl(display));
  await page.getByTestId("service-A").click();
  await page.getByTestId("name").waitFor();
  await expect(page.getByTestId("hero")).toHaveCount(0);
  expect(await layoutIssues(page)).toEqual([]);
  await shot(page, "small-custimg-06-no-images-form");
  const r = await page.request.get(`${URLS.api}/api/s/${s.code}/session?${new URL(await qrUrl(display)).searchParams}`);
  expect((await r.json()).images).toEqual([]);
  await page.context().close();
  await display.context().close();
});

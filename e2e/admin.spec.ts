/**
 * M4 總後台（手機直版優先）：門店列表／篩選／搜尋、門店詳情（警示、面板、上限、功能開關、店長帳號、停用、刪除）、
 * 建立門店、用量與成本、每店用量、帳單輸入、CSV、稽核、品牌、更多；載入／錯誤／需要登入狀態。
 * 本機以 DEV_BYPASS_ACCESS 通過 Access（身分 dev@local）。每頁 390×844 與 360×640 截圖＋量測。
 */
import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";
import { PHONE, SMALL, URLS, layoutIssues, seed, shot, textIssues } from "./helpers";

test.describe.configure({ mode: "serial" });

async function check(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(200);
  await shot(page, name, false);
  if (fullPage && (await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 4))) await shot(page, `${name}-full`, true);
  expect(await layoutIssues(page), name).toEqual([]);
  expect(await textIssues(page), name).toEqual([]);
}

async function go(page: Page, path: string, testId: string) {
  await page.evaluate((p) => {
    history.pushState(null, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.getByTestId(testId).waitFor();
  await expect(page.getByTestId("loading")).toHaveCount(0);
}

async function open(browser: import("@playwright/test").Browser, opts: BrowserContextOptions) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(URLS.admin + "/");
  await page.getByTestId("stores").waitFor();
  await expect(page.getByTestId("loading")).toHaveCount(0);
  return page;
}

for (const [opts, pre] of [
  [PHONE, "admin"],
  [SMALL, "small-admin"],
] as const) {
  test(`總後台 門店（${pre}）：列表、篩選、搜尋、詳情、建立、上限、店長帳號、停用、刪除`, async ({ browser }) => {
    const zs = seed("DEMO01");
    const page = await open(browser, opts);
    await expect(page.getByTestId("store-list")).toBeVisible();
    await expect(page.getByTestId("store-DEMO01")).toContainText("夜間 DO 未休眠");
    await expect(page.getByTestId("store-DEMO04")).toContainText("無法出聲");
    await expect(page.getByTestId("store-DEMO04")).toContainText("廣告容量");
    await check(page, `${pre}-01-stores`);

    await page.getByTestId("filter-suspended").click();
    await expect(page.getByTestId("store-DEMO03")).toContainText("已停用");
    await expect(page.getByTestId("store-DEMO01")).toHaveCount(0);
    await check(page, `${pre}-02-stores-suspended`);
    await page.getByTestId("filter-expired").click();
    await expect(page.getByTestId("store-DEMO05")).toContainText("已到期");
    await page.getByTestId("filter-all").click();
    await page.getByTestId("search").fill("不存在的店");
    await page.getByRole("button", { name: "搜尋" }).click();
    await expect(page.getByTestId("empty")).toContainText("找不到符合的門店");
    await check(page, `${pre}-03-stores-empty`);
    await page.getByTestId("search").fill("");
    await page.getByRole("button", { name: "搜尋" }).click();

    // 詳情：中山店（夜間警示、面板、店長）
    await page.getByTestId("store-DEMO01").click();
    await page.getByTestId("store-detail").waitFor();
    await expect(page.getByTestId("loading")).toHaveCount(0);
    await expect(page.getByTestId("alerts")).toContainText("夜間 DO 未休眠");
    await expect(page.getByTestId("panels")).toContainText("叫號面板 1 / 2");
    await expect(page.getByTestId("admins")).toContainText(zs.adminEmail);
    await check(page, `${pre}-04-store-detail`);

    // 新莊店：無法出聲（D1 狀態 > 5 分鐘）＋廣告容量 90%
    await go(page, `/stores/st_demo_xz`, "store-detail");
    await expect(page.getByTestId("alerts")).toContainText("無法出聲");
    await expect(page.getByTestId("limits")).toContainText("已用 458 MB / 500 MB（92%）");
    await check(page, `${pre}-05-store-muted-quota`);

    // 桃園店：已到期
    await go(page, `/stores/st_demo_ty`, "store-detail");
    await expect(page.getByTestId("status-card")).toContainText("已超過到期日");
    await check(page, `${pre}-06-store-expired`, false);

    // 建立門店：驗證 → 成功 → 密碼只顯示一次
    await go(page, "/stores/new", "store-new");
    await check(page, `${pre}-07-new-store`);
    await page.getByTestId("create-submit").click();
    await expect(page.getByText("請輸入門店名稱")).toBeVisible();
    await expect(page.getByText("請輸入正確的 Email")).toBeVisible();
    await check(page, `${pre}-08-new-store-errors`, false);
    await page.getByTestId("name").fill(`E2E 測試店 ${pre}`);
    await page.getByTestId("code").fill("DEMO01");
    await page.getByTestId("admin-email").fill(`e2e-${pre}@example.com`);
    await page.getByTestId("create-submit").click();
    await expect(page.getByText("這個門店碼已經被使用")).toBeVisible();
    await check(page, `${pre}-09-new-store-code-taken`, false);
    await page.getByTestId("code").fill("");
    await page.getByTestId("create-submit").click();
    await page.getByTestId("store-created").waitFor();
    await expect(page.getByTestId("password")).toHaveText(/^[A-Za-z0-9]{12}$/);
    await check(page, `${pre}-10-store-created`);
    // 用初始密碼登入門店後台（API）
    const pw = (await page.getByTestId("password").textContent())!;
    const login = await page.request.post(`${URLS.api}/api/store/auth/login`, { data: { email: `e2e-${pre}@example.com`, password: pw } });
    expect(login.status()).toBe(200);
    await page.getByTestId("go-store").click();
    await page.getByTestId("store-detail").waitFor();

    // 上限：錯誤值 → 欄位錯誤；正確 → 儲存
    await page.getByTestId("max-devices").fill("abc");
    await page.getByTestId("save-limits").click();
    await expect(page.getByText("請輸入 0～50")).toBeVisible();
    await check(page, `${pre}-11-limits-error`, false);
    await page.getByTestId("max-devices").fill("3");
    await page.getByTestId("feature-internal").click();
    await page.getByRole("button", { name: "＋1 年" }).click();
    await page.getByTestId("save-limits").click();
    await expect(page.getByTestId("toast")).toContainText("已儲存");
    await expect(page.getByTestId("panels")).toContainText("叫號面板 0 / 3");

    // 新增店長 → 密碼只顯示一次
    await page.getByTestId("add-admin").click();
    await page.getByTestId("new-admin-submit").click();
    await expect(page.getByTestId("new-admin")).toContainText("請輸入正確的 Email");
    await check(page, `${pre}-12-new-admin-sheet`, false);
    await page.getByTestId("new-admin-email").fill(`e2e-${pre}-2@example.com`);
    await page.getByTestId("new-admin-submit").click();
    await expect(page.getByTestId("password-once")).toBeVisible();
    await expect(page.getByTestId("admin-row")).toHaveCount(2);
    await check(page, `${pre}-13-admin-added`);

    // 停用 → 確認 → 已停用 → 恢復
    await page.getByTestId("suspend").click();
    await check(page, `${pre}-14-suspend-confirm`, false);
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("status-card")).toContainText("已停用");
    await page.getByTestId("resume").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("status-card")).toContainText("營業中");

    // 刪除（封存）：門店碼確認才可按
    await page.getByTestId("delete-store").click();
    await expect(page.getByTestId("delete-confirm")).toBeDisabled();
    await check(page, `${pre}-15-delete-sheet`, false);
    const code = (await page.getByTestId("delete-sheet").textContent())!.match(/門店碼 ([A-Z0-9]+) 確認/)![1];
    await page.getByTestId("delete-code").fill(code.toLowerCase());
    await page.getByTestId("delete-confirm").click();
    await page.getByTestId("stores").waitFor();
    await page.getByTestId("filter-deleted").click();
    await expect(page.getByTestId("store-list")).toContainText(`E2E 測試店 ${pre}`);
    await page.context().close();
  });

  test(`總後台 用量與成本（${pre}）：總覽、排行、每店、帳單、CSV`, async ({ browser }) => {
    const page = await open(browser, opts);
    await page.getByTestId("tab-用量").click();
    await page.getByTestId("usage").waitFor();
    await expect(page.getByTestId("loading")).toHaveCount(0);
    await expect(page.getByTestId("overview")).toContainText("依單價估算");
    await expect(page.getByTestId("usage-list")).toContainText("示範門市 中山店");
    await check(page, `${pre}-20-usage`);
    await page.getByTestId("sort-tickets").click();
    await expect(page.getByTestId("usage-list").locator("li").first()).toContainText("中山店");
    await page.getByTestId("export").click();
    await check(page, `${pre}-21-csv-sheet`, false);
    const href = await page.getByTestId("csv-monthly").getAttribute("href");
    const csv = await page.request.get(URLS.admin + href);
    expect(csv.status()).toBe(200);
    expect((await csv.body()).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(await csv.text()).toContain("DEMO01");
    await page.keyboard.press("Escape");

    // 上個月：有帳單 → 實際金額與分攤
    await page.getByTestId("prev-month").click();
    await expect(page.getByTestId("overview")).toContainText("$5.37");
    await check(page, `${pre}-22-usage-last-month`);

    // 每店用量
    await page.getByTestId("usage-DEMO01").click();
    await page.getByTestId("store-usage").waitFor();
    await expect(page.getByTestId("loading")).toHaveCount(0);
    await expect(page.getByTestId("day-list").locator("li")).toHaveCount(30);
    await expect(page.getByTestId("today")).toContainText("部署後才有");
    await check(page, `${pre}-23-store-usage`);

    // 帳單輸入：錯誤 → 儲存
    await go(page, "/billing", "billing");
    await check(page, `${pre}-24-billing`);
    await page.getByTestId("bill-workers_base").fill("5.123");
    await page.getByTestId("billing-save").click();
    await expect(page.getByText("請輸入金額（最多兩位小數）")).toBeVisible();
    await check(page, `${pre}-25-billing-error`, false);
    await page.getByTestId("bill-workers_base").fill("5");
    // 兩種尺寸各輸入不同金額（同金額會被視為「沒有變更」）
    const amt = pre === "admin" ? "0.25" : "0.3";
    await page.getByTestId("bill-do_requests").fill(amt);
    await page.getByTestId("billing-save").click();
    await page.getByTestId("usage").waitFor();
    await expect(page.getByTestId("overview")).toContainText(pre === "admin" ? "$5.25" : "$5.30");
    // 沒改任何金額 → 不送出、提示「沒有變更」
    await page.getByTestId("go-billing").click();
    await page.getByTestId("billing").waitFor();
    await expect(page.getByTestId(`bill-do_requests`)).toHaveValue(amt);
    await page.getByTestId("billing-save").click();
    await expect(page.getByTestId("toast")).toContainText("沒有變更");
    await page.context().close();
  });

  test(`總後台 稽核／品牌／更多與各種狀態（${pre}）`, async ({ browser }) => {
    const page = await open(browser, opts);
    await page.getByTestId("tab-稽核").click();
    await page.getByTestId("audit-list").waitFor();
    await check(page, `${pre}-30-audit`);
    await page.getByTestId("audit-action").selectOption("store.*");
    await expect(page.getByTestId("audit-item").first()).toBeVisible();
    await check(page, `${pre}-31-audit-filtered`, false);

    await page.getByTestId("tab-更多").click();
    await page.getByTestId("more").waitFor();
    await expect(page.getByTestId("me-email")).toHaveText("dev@local");
    await check(page, `${pre}-32-more`);
    await go(page, "/brands", "brands");
    await check(page, `${pre}-33-brands`);
    await page.getByTestId("new-brand").click();
    await page.getByTestId("brand-save").click();
    await expect(page.getByTestId("brand-sheet")).toContainText("請輸入品牌名稱");
    await check(page, `${pre}-34-brand-sheet`, false);
    await page.keyboard.press("Escape");

    // 載入中（API 延遲）
    await page.route("**/api/admin/usage?**", async (r) => {
      await new Promise((x) => setTimeout(x, 1500));
      await r.continue();
    });
    await page.evaluate(() => {
      history.pushState(null, "", "/usage");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByTestId("loading").waitFor();
    await shot(page, `${pre}-35-loading`);
    await page.unroute("**/api/admin/usage?**");
    // 讀取失敗
    await page.route("**/api/admin/stores?**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL"}' }));
    await page.getByTestId("tab-門店").click();
    await expect(page.getByTestId("error")).toContainText("讀取失敗");
    await check(page, `${pre}-36-load-error`, false);
    await page.context().close();

    // Access 驗證失敗（JWT 過期／名單外）
    const ctx = await browser.newContext(opts);
    const p2 = await ctx.newPage();
    await p2.route("**/api/admin/me", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"code":"ACCESS_REQUIRED"}' }));
    await p2.goto(URLS.admin + "/");
    await p2.getByTestId("access-required").waitFor();
    await check(p2, `${pre}-37-access-required`, false);
    await ctx.close();
  });
}

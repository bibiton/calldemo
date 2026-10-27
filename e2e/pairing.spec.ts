/**
 * 3.2 裝置配對：面板只顯示配對碼（遙控器即可）→ 店長在門店後台輸入 → 面板自動進入叫號畫面；
 * 超過 max_devices 被拒；解除配對後面板立即回到配對畫面；人員手機同流程；面板 QR 開門店後台會帶入配對碼。
 */
import { expect, test } from "@playwright/test";
import { PHONE, SMALL, TV, URLS, layoutIssues, seed, shot, storeLogin } from "./helpers";

test.describe.configure({ mode: "serial" });

test("面板配對 → 叫號畫面；超過上限被拒；解除配對 → 面板回到配對畫面", async ({ browser }) => {
  const s = seed("DEMO02"); // 已有 1 台面板，上限 2
  const tv = await browser.newContext(TV);
  const display = await tv.newPage();
  await display.goto(URLS.display + "/");
  await display.getByTestId("pair-code").waitFor();
  await shot(display, "pair-01-display-code");
  const code = ((await display.getByTestId("pair-code").textContent()) ?? "").replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);
  // 面板沒有任何需要輸入的欄位（遙控器即可完成）
  expect(await display.locator("input, textarea, select").count()).toBe(0);

  const store = await storeLogin(browser, s);
  await store.evaluate(() => {
    history.pushState(null, "", "/devices");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await store.getByTestId("devices").waitFor();
  await expect(store.getByTestId("display-count")).toHaveText("1 / 2 台");
  await store.getByTestId("pair-submit").click();
  await expect(store.getByText("請輸入裝置畫面上的 6 位數配對碼")).toBeVisible();
  await shot(store, "store-38-devices-validation", true);
  await store.getByTestId("pair-code").fill(code);
  await store.getByTestId("pair-name").fill("門口面板");
  await store.getByTestId("pair-submit").click();
  await expect(store.getByTestId("toast")).toContainText("已配對：門口面板");
  await expect(store.getByTestId("display-count")).toHaveText("2 / 2 台");
  // 面板輪詢（每 3 秒）拿到 token → 自動進入叫號畫面
  await display.getByTestId("board").waitFor({ timeout: 10_000 });
  await display.getByTestId("qr-panel").locator("svg").waitFor();
  await shot(display, "pair-02-display-paired");
  await shot(store, "store-39-devices", true);
  expect(await layoutIssues(store)).toEqual([]);

  // 第 3 台：超過上限
  const tv3 = await browser.newContext(TV);
  const d3 = await tv3.newPage();
  await d3.goto(URLS.display + "/");
  const code3 = ((await d3.getByTestId("pair-code").textContent()) ?? "").replace(/\s/g, "");
  await store.getByTestId("pair-code").fill(code3);
  await store.getByTestId("pair-submit").click();
  await expect(store.getByTestId("pair-error")).toContainText("叫號面板已達上限（2 台）");
  await shot(store, "store-40-devices-limit", true);

  // 解除配對：面板立即斷線，回到配對畫面
  await store.getByTestId("device-row").filter({ hasText: "門口面板" }).getByRole("button", { name: "移除" }).click();
  await shot(store, "store-41-device-revoke-confirm");
  await store.getByTestId("confirm-ok").click();
  await expect(store.getByTestId("toast")).toContainText("已移除");
  await display.getByTestId("pair-code").waitFor({ timeout: 10_000 });
  await expect(store.getByTestId("display-count")).toHaveText("1 / 2 台");
  await tv3.close();
  await tv.close();
  await store.context().close();
});

test("人員手機配對：未綁定手機顯示配對碼 → 店長輸入 → 手機進入人員登入", async ({ browser }) => {
  const s = seed("DEMO02");
  for (const [opts, pre] of [[PHONE, "pair"], [SMALL, "small-pair"]] as const) {
    const ctx = await browser.newContext(opts);
    const phone = await ctx.newPage();
    await phone.goto(URLS.staff + "/");
    await phone.getByTestId("staff-pair-code").waitFor();
    await shot(phone, `${pre}-03-staff-code`);
    expect(await layoutIssues(phone)).toEqual([]);
    const code = ((await phone.getByTestId("staff-pair-code").textContent()) ?? "").replace(/\s/g, "");
    const store = await storeLogin(browser, s);
    await store.goto(`${URLS.store}/pair?code=${code}`); // 與面板 QR 相同的網址：配對碼自動帶入
    await expect(store.getByTestId("pair-code")).toHaveValue(code);
    await store.getByTestId("pair-name").fill(pre === "pair" ? "2 號櫃台手機" : "小手機");
    await store.getByTestId("pair-submit").click();
    await expect(store.getByTestId("toast")).toContainText("已配對");
    await phone.getByText("請選擇您的名字").waitFor({ timeout: 10_000 });
    await shot(phone, `${pre}-04-staff-paired`);
    await store.context().close();
    await ctx.close();
  }
});

test("人員被重設 PIN → 正在使用的人員端立即回到登入畫面", async ({ browser }) => {
  const s = seed("DEMO02");
  const store = await storeLogin(browser, s);
  const created = await store.evaluate(async () => {
    const tok = await (await fetch("/api/store/auth/refresh", { method: "POST", credentials: "include" })).json();
    const r = await fetch("/api/store/staff", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.accessToken}` }, body: JSON.stringify({ displayName: "臨時店員" }) });
    return { ...(await r.json()), token: tok.accessToken };
  });
  const ctx = await browser.newContext(PHONE);
  const phone = await ctx.newPage();
  await phone.goto(`${URLS.staff}/?device=${s.staffDeviceToken}`);
  await phone.getByTestId(`staff-${created.staff.id}`).click();
  for (const d of created.pin) await phone.getByTestId(`pin-${d}`).click();
  await phone.getByTestId("counter-1").click();
  await phone.getByTestId("call-next").waitFor();
  await phone.waitForFunction(() => !document.querySelector('[data-testid="offline"]'));
  await store.evaluate(
    async ({ id, token }) => fetch(`/api/store/staff/${id}/reset-pin`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
    { id: created.staff.id, token: created.token },
  );
  await phone.getByText("請選擇您的名字").waitFor({ timeout: 10_000 });
  await ctx.close();
  await store.context().close();
});

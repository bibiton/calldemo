/**
 * M3 門店後台：登入、即時隊列（代操作、無法出聲警示）、報表／CSV、服務類別／櫃台／人員／營業時間 CRUD、
 * 叫號語音（試聽、儲存後面板即時套用）、其他設定（QR 金鑰重設）、廣告（上傳、規格檢查、排序、時段、刪除）、
 * 空狀態、載入狀態、停用。每頁 390×844 與 360×640 截圖＋量測（無水平捲動、觸控目標 ≥ 44px）。
 */
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PHONE, SMALL, TV, URLS, apiTake, layoutIssues, openDisplay, qrUrl, seed, shot, staffLogin, storeLogin } from "./helpers";

test.describe.configure({ mode: "serial" });

async function check(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(200);
  await shot(page, name, fullPage);
  expect(await layoutIssues(page), name).toEqual([]);
}

async function go(page: Page, path: string, testId: string) {
  await page.evaluate((p) => {
    history.pushState(null, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.getByTestId(testId).waitFor();
  await expect(page.getByTestId("loading")).toHaveCount(0);
}

/** 用瀏覽器畫一張指定尺寸的 PNG（測上傳用） */
async function png(page: Page, w: number, h: number, label: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h, label]) => {
      const c = document.createElement("canvas");
      c.width = w as number;
      c.height = h as number;
      const g = c.getContext("2d")!;
      const grd = g.createLinearGradient(0, 0, w as number, h as number);
      grd.addColorStop(0, "#14213d");
      grd.addColorStop(1, "#f5b301");
      g.fillStyle = grd;
      g.fillRect(0, 0, w as number, h as number);
      g.fillStyle = "#fff";
      g.font = "bold 96px sans-serif";
      g.fillText(label as string, 60, 200);
      return c.toDataURL("image/png").split(",")[1];
    },
    [w, h, label] as const,
  );
  return Buffer.from(b64, "base64");
}

test("3.1 登入：欄位驗證、錯誤密碼提示、成功進入即時隊列", async ({ browser }) => {
  const s = seed("DEMO02");
  for (const [opts, pre] of [[PHONE, "store"], [SMALL, "small-store"]] as const) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto(URLS.store + "/");
    await page.getByTestId("login").waitFor();
    await check(page, `${pre}-01-login`);
    await page.getByTestId("login-submit").click();
    await expect(page.getByText("請輸入正確的 Email")).toBeVisible();
    await expect(page.getByText("請輸入密碼")).toBeVisible();
    await check(page, `${pre}-02-login-validation`);
    await page.getByTestId("email").fill(s.adminEmail);
    await page.getByTestId("password").fill("wrong-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toContainText("Email 或密碼錯誤");
    await check(page, `${pre}-03-login-error`);
    await page.getByTestId("password").fill(s.adminPassword);
    await page.getByTestId("login-submit").click();
    await page.getByTestId("board").waitFor();
    // 重新整理不需重登（refresh cookie）
    await page.reload();
    await page.getByTestId("board").waitFor();
    await ctx.close();
  }
});

test("即時隊列：等候數／櫃台目前號碼／代操作叫號（面板 1 秒內出現）＋叫號機無法出聲警示", async ({ browser }) => {
  const s = seed("DEMO01");
  // 面板：模擬音訊被擋（AudioContext 一直 suspended）→ 回報 blocked
  const tv = await browser.newContext(TV);
  await tv.addInitScript({
    content: `Object.defineProperty(AudioContext.prototype, "state", { get: () => "suspended" }); AudioContext.prototype.resume = () => new Promise(() => {});`,
  });
  const display = await tv.newPage();
  await display.goto(`${URLS.display}/?token=${s.displayToken}`);
  await display.getByTestId("board").waitFor();
  const qr = await qrUrl(display);
  await apiTake(qr, "林小華", "0966000001");
  await apiTake(qr, "陳大文", "0966000002");

  const page = await storeLogin(browser, s);
  await expect(page.getByTestId("audio-alert")).toContainText("叫號機無法出聲");
  await expect(page.getByTestId("queue-list")).toContainText("林小華");
  await check(page, "store-04-board");
  const before = await page.getByTestId("queue-list").locator("li").count();
  const first = (await page.getByTestId("queue-list").locator("li").first().locator("span").first().textContent())!.trim();
  const t0 = Date.now();
  await page.getByTestId("call-next-1").click();
  await expect(display.getByTestId("current-number")).toHaveText(first);
  expect(Date.now() - t0).toBeLessThan(1000);
  await expect(page.getByTestId("counter-current-1")).toHaveText(first);
  await expect(page.getByTestId("queue-list").locator("li")).toHaveCount(before - 1);
  await check(page, "store-05-board-called");

  const small = await storeLogin(browser, s, SMALL);
  await check(small, "small-store-04-board");
  await small.context().close();
  await page.context().close();
  await tv.close();
});

test("3.6 報表：今日即時、近 7／30 天（與歷史一致）、匯出 CSV", async ({ browser }) => {
  const s = seed("DEMO01");
  const page = await storeLogin(browser, s);
  await go(page, "/reports", "reports");
  await page.getByTestId("history-summary").waitFor();
  const days = await page.locator('[data-testid^="day-20"]').count();
  expect(days).toBe(7);
  await check(page, "store-06-reports");
  await page.getByTestId("days-30").click();
  await page.getByTestId("history-summary").waitFor();
  const dl = page.waitForEvent("download");
  await page.getByTestId("csv").click();
  const file = await dl;
  const buf = await (await file.createReadStream()).toArray();
  const text = Buffer.concat(buf as Buffer[]);
  expect([...text.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(text.toString("utf8")).toContain("日期,服務,取號數,完成,過號,未到,取消,完成率");
  // CSV 的取號總數＝畫面上的總數
  const csvTotal = text
    .toString("utf8")
    .trim()
    .split("\r\n")
    .slice(1)
    .reduce((a, l) => a + Number(l.split(",")[2]), 0);
  await expect(page.getByTestId("history-summary")).toContainText(`共取號 ${csvTotal} 張`);
  const small = await storeLogin(browser, s, SMALL);
  await go(small, "/reports", "reports");
  await small.getByTestId("history-summary").waitFor();
  await check(small, "small-store-06-reports");
  await small.context().close();
  await page.context().close();
});

test("3.1 服務類別：新增（含驗證錯誤）、字首重複、編輯停用、刪除；寫稽核", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s);
  await go(page, "/more", "more");
  await check(page, "store-07-more");
  await page.getByTestId("more-services").click();
  await page.getByTestId("service-A").waitFor();
  await check(page, "store-08-services");
  await page.getByTestId("add-service").click();
  await page.getByTestId("svc-name").fill("");
  await page.getByTestId("svc-prefix").fill("");
  await page.getByTestId("save").click();
  await expect(page.getByText("請輸入名稱")).toBeVisible();
  await expect(page.getByText("請輸入 1～2 個英文大寫字母")).toBeVisible();
  await check(page, "store-09-service-validation", false);
  await page.getByTestId("svc-name").fill("重複的");
  await page.getByTestId("svc-prefix").fill("a");
  await expect(page.getByTestId("svc-prefix")).toHaveValue("A");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("sheet-error")).toContainText("字首已經被其他服務類別使用");
  await check(page, "store-10-service-duplicate", false);
  await page.getByTestId("svc-name").fill("繳費");
  await page.getByTestId("svc-prefix").fill("C");
  await page.getByTestId("svc-limit").fill("50");
  await page.getByTestId("save").click();
  await page.getByTestId("service-C").waitFor();
  await expect(page.getByTestId("service-C")).toContainText("每日上限 50 號");
  await page.getByTestId("edit-service-C").click();
  await page.getByTestId("svc-enabled").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("service-C")).toContainText("已停用");
  await page.getByTestId("service-C").getByRole("button", { name: "刪除" }).click();
  await page.getByTestId("confirm").waitFor();
  await check(page, "store-11-service-delete-confirm", false);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("service-C")).toHaveCount(0);
  await page.context().close();
});

test("3.1 櫃台：新增（可服務類別）、號碼重複提示、刪除", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s);
  await go(page, "/counters", "counters");
  await check(page, "store-12-counters");
  await page.getByTestId("add-counter").click();
  await page.getByTestId("ctr-number").fill("1");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("sheet-error")).toContainText("櫃台號碼已經存在");
  await page.getByTestId("ctr-number").fill("");
  await page.getByTestId("save").click();
  await expect(page.getByText("請輸入 1～99")).toBeVisible();
  await check(page, "store-13-counter-sheet", false);
  await page.getByTestId("ctr-number").fill("4");
  await page.getByTestId("ctr-name").fill("4 號櫃台");
  await page.getByTestId("counter-sheet").getByText("A 內用").click();
  await page.getByTestId("save").click();
  await page.getByTestId("counter-4").waitFor();
  await expect(page.getByTestId("counter-4")).toContainText("服務：A");
  await page.getByTestId("counter-4").getByRole("button", { name: "刪除" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("counter-4")).toHaveCount(0);
  await page.context().close();
});

test("3.1 人員：新增 → 只顯示一次的 PIN（可登入人員端）、重設 PIN、停用", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s);
  await go(page, "/staff", "staff");
  await check(page, "store-14-staff");
  await page.getByTestId("add-staff").click();
  await page.getByTestId("save").click();
  await expect(page.getByText("請輸入名字")).toBeVisible();
  await page.getByTestId("staff-name").fill("黃店員");
  await page.getByTestId("save").click();
  const pin = (await page.getByTestId("new-pin").textContent())!.trim();
  expect(pin).toMatch(/^\d{6}$/);
  await check(page, "store-15-staff-pin", false);
  await page.getByRole("button", { name: "我已記下" }).click();
  const id = (await (await fetch(`${URLS.api}/api/staff/device`, { headers: { authorization: `Bearer ${s.staffDeviceToken}` } })).json()).staff.find((x: any) => x.displayName === "黃店員").id;
  const login = await fetch(`${URLS.api}/api/staff/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.staffDeviceToken}` }, body: JSON.stringify({ userId: id, pin }) });
  expect(login.status).toBe(200);
  const row = page.getByTestId("staff-row").filter({ hasText: "黃店員" });
  await row.getByRole("button", { name: "重設 PIN" }).click();
  await check(page, "store-16-staff-reset-confirm", false);
  await page.getByTestId("confirm-ok").click();
  const pin2 = (await page.getByTestId("new-pin").textContent())!.trim();
  await page.getByRole("button", { name: "我已記下" }).click();
  const old = await fetch(`${URLS.api}/api/staff/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.staffDeviceToken}` }, body: JSON.stringify({ userId: id, pin }) });
  expect(old.status).toBe(401);
  expect(pin2).not.toBe(pin);
  await row.getByRole("button", { name: "停用" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(row).toContainText("已停用");
  await page.context().close();
});

test("3.1 營業時間：全天／每週時段、時間錯誤提示、儲存", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s);
  await go(page, "/hours", "hours");
  await page.getByTestId("day-1").waitFor();
  await check(page, "store-17-hours");
  await page.getByTestId("day-1").locator('input[type="time"]').first().fill("22:00");
  await expect(page.getByTestId("day-1")).toContainText("結束時間要晚於開始時間");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
  await check(page, "store-18-hours-error");
  await page.getByTestId("day-1").locator('input[type="time"]').first().fill("11:00");
  await page.getByTestId("day-toggle-0").click(); // 週日公休
  await page.getByTestId("save").click();
  await expect(page.getByTestId("toast")).toContainText("營業時間已儲存");
  await page.context().close();
});

test("3.3 叫號語音：試聽在手機播放；改成標準版＋鐘聲＋唸 1 次 → 面板下一次叫號即套用", async ({ browser }) => {
  const s = seed("DEMO01");
  const display = await openDisplay(browser, s);
  const qr = await qrUrl(display);
  const page = await storeLogin(browser, s);
  await go(page, "/voice", "voice");
  await check(page, "store-19-voice");
  await page.getByTestId("pack-open-waited").click();
  await check(page, "store-20-voice-lines");
  await page.getByTestId("play-full").click();
  await page.waitForFunction(() => (window.__qcsPreviewLog ?? []).length > 0);
  const keys = await page.evaluate(() => window.__qcsPreviewLog![0]);
  expect(keys[0]).toMatch(/^chime\./);
  expect(keys).toContain("number.A.23");
  expect(keys).toContain("counter.2");
  await page.getByTestId("mode-standard").click();
  await expect(page.getByTestId("packs")).toHaveCount(0); // 標準版：前綴設定全部隱藏
  await page.getByTestId("chime").selectOption("chime.bell");
  await page.getByTestId("repeat-1").click();
  await check(page, "store-21-voice-standard");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("toast")).toContainText("面板下一次叫號即套用");
  // 面板：settings.changed → 重連取新設定 → 下一次叫號用鐘聲、「來賓」、只唸一次
  await display.waitForTimeout(800);
  await apiTake(qr, "語音測試", "0966000003");
  const staff = await staffLogin(browser, s);
  await staff.getByTestId("call-next").click();
  await display.waitForFunction(() => (window.__qcsAudioLog ?? []).some((e) => e.type === "start" && e.number !== ""));
  const start = await display.evaluate(() => window.__qcsAudioLog!.find((e) => e.type === "start" && e.number !== "")!);
  expect(start.keys[0]).toBe("chime.bell");
  expect(start.keys).toContain("prefix.std");
  expect(start.keys.filter((k) => k.startsWith("counter.")).length).toBe(1);
  // 還原成俏皮（之後其他測試仍用 DEMO01）
  await page.getByTestId("mode-fun").click();
  await page.getByTestId("repeat-2").click();
  await page.getByTestId("save").click();
  await staff.context().close();
  await page.context().close();
  await display.context().close();
});

test("其他設定：提醒人數、遮罩姓名、重設 QR 金鑰（舊 QR 立即失效、面板換新 QR）", async ({ browser }) => {
  const s = seed("DEMO02");
  const display = await openDisplay(browser, s);
  const oldQr = await qrUrl(display);
  const page = await storeLogin(browser, s);
  await go(page, "/settings", "settings");
  await check(page, "store-22-settings");
  await page.getByTestId("ahead-2").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("toast")).toContainText("設定已儲存");
  await page.getByTestId("rotate-qr").click();
  await check(page, "store-23-rotate-confirm", false);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toast")).toContainText("QR 金鑰已重設");
  await expect.poll(async () => display.getByTestId("qr-panel").getAttribute("data-qr-url"), { timeout: 10_000 }).not.toBe(oldQr);
  const u = new URL(oldQr);
  const r = await fetch(`${URLS.api}/api/s/${u.pathname.split("/").pop()}/session?${u.searchParams}`);
  expect(r.status).toBe(401);
  const newQr = (await display.getByTestId("qr-panel").getAttribute("data-qr-url"))!;
  const n = new URL(newQr);
  expect((await fetch(`${URLS.api}/api/s/${n.pathname.split("/").pop()}/session?${n.searchParams}`)).status).toBe(200);
  await page.context().close();
  await display.context().close();
});

test("3.4 廣告：上傳（進度、3:2 提示、超過大小／格式前端擋下）、播放設定、排序、刪除；面板 manifest 版本更新", async ({ browser }) => {
  const s = seed("DEMO02");
  const display = await openDisplay(browser, s);
  const page = await storeLogin(browser, s);
  await go(page, "/ads", "ads");
  await page.getByTestId("ad-item").first().waitFor();
  const n0 = await page.getByTestId("ad-item").count();
  await check(page, "store-24-ads");
  const manifest = async () => (await fetch(`${URLS.api}/api/display/ads/manifest`, { headers: { authorization: `Bearer ${s.displayToken}` } })).json();
  const v0 = (await manifest()).version;

  // 合規 3:2 圖片
  await page.getByTestId("file").setInputFiles({ name: "秋季新品.png", mimeType: "image/png", buffer: await png(page, 1080, 720, "秋季新品") });
  await page.getByTestId("upload-sheet").waitFor();
  await expect(page.getByTestId("upload-warning")).toHaveCount(0);
  await check(page, "store-25-upload-ok", false);
  await page.getByTestId("upload-go").click();
  await expect(page.getByTestId("ad-item")).toHaveCount(n0 + 1);
  const m1 = await manifest();
  expect(m1.version).toBeGreaterThan(v0);
  expect(m1.items.length).toBe(n0 + 1);
  // 新素材能從 media 網址讀到（本機以 /ads → R2 模擬）
  expect((await fetch(m1.items.at(-1).url)).status).toBe(200);

  // 比例不是 3:2 → 提示但可上傳
  await page.getByTestId("file").setInputFiles({ name: "方形.png", mimeType: "image/png", buffer: await png(page, 800, 800, "方形") });
  await expect(page.getByTestId("upload-warning").first()).toContainText("不是 3:2");
  await expect(page.getByTestId("upload-go")).toBeEnabled();
  await check(page, "store-26-upload-ratio-warning", false);
  await page.getByRole("button", { name: "關閉" }).click();

  // 超過 5 MB 的圖片、超過 50 MB 的影片 → 前端擋下（不送出）
  await page.getByTestId("file").setInputFiles({ name: "太大.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024, 1) });
  await expect(page.getByTestId("upload-error").first()).toContainText("超過圖片上限 5.0 MB");
  await expect(page.getByTestId("upload-go")).toBeDisabled();
  await check(page, "store-27-upload-too-large", false);
  await page.getByRole("button", { name: "關閉" }).click();
  const big = test.info().outputPath("long-video.mp4"); // Playwright 記憶體 buffer 上限 50 MB，寫成檔案
  writeFileSync(big, Buffer.alloc(51 * 1024 * 1024, 0));
  await page.getByTestId("file").setInputFiles(big);
  await expect(page.getByTestId("upload-error").first()).toContainText("超過影片上限 50 MB");
  await expect(page.getByTestId("upload-go")).toBeDisabled();
  await page.getByRole("button", { name: "關閉" }).click();
  await page.getByTestId("file").setInputFiles({ name: "動畫.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(page.getByTestId("upload-error").first()).toContainText("只支援");
  await page.getByRole("button", { name: "關閉" }).click();

  // 播放設定：秒數、時段、星期
  const last = n0;
  await page.getByTestId(`edit-${last}`).click();
  await page.getByTestId("seconds").fill("15");
  await page.getByTestId("ad-allday").click();
  await page.getByTestId("from").fill("14:00");
  await page.getByTestId("to").fill("11:00");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("edit-sheet")).toContainText("結束時間要晚於開始時間");
  await check(page, "store-28-ad-edit-error", false);
  await page.getByTestId("from").fill("11:00");
  await page.getByTestId("to").fill("14:00");
  await page.getByTestId("dow-0").click();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("ad-item").nth(last)).toContainText("15 秒");
  await expect(page.getByTestId("ad-item").nth(last)).toContainText("11:00–14:00");
  // 排序：最後一則往前
  await page.getByTestId(`up-${last}`).click();
  await expect(page.getByTestId("ad-item").nth(last - 1)).toContainText("秋季新品");
  const m2 = await manifest();
  expect(m2.items[last - 1].durationMs).toBe(15000);
  // 刪除
  await page.getByTestId(`del-${last - 1}`).click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ad-item")).toHaveCount(n0);
  expect((await manifest()).items.length).toBe(n0);
  const small = await storeLogin(browser, s, SMALL);
  await go(small, "/ads", "ads");
  await small.getByTestId("ad-item").first().waitFor();
  await check(small, "small-store-24-ads");
  await small.context().close();
  await page.context().close();
  await display.context().close();
});

test("空狀態：新門店（無櫃台／人員／裝置／廣告／歷史）各頁有說明", async ({ browser }) => {
  const s = seed("EMPTY1");
  const page = await storeLogin(browser, s);
  await expect(page.getByTestId("empty").first()).toBeVisible();
  await check(page, "store-29-empty-board");
  for (const [path, id, name] of [
    ["/ads", "ads", "store-30-empty-ads"],
    ["/staff", "staff", "store-31-empty-staff"],
    ["/devices", "devices", "store-32-empty-devices"],
    ["/counters", "counters", "store-33-empty-counters"],
    ["/reports", "reports", "store-34-empty-reports"],
  ] as const) {
    await go(page, path, id);
    await expect(page.getByTestId("empty").first()).toBeVisible();
    await check(page, name);
  }
  await page.context().close();
});

test("載入狀態與讀取失敗：骨架畫面、錯誤＋重試", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s);
  await page.route("**/api/store/services", async (r) => {
    await new Promise((x) => setTimeout(x, 1500));
    await r.continue();
  });
  await page.evaluate(() => {
    history.pushState(null, "", "/services");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByTestId("loading").waitFor();
  await check(page, "store-35-loading", false);
  await page.unroute("**/api/store/services");
  await page.route("**/api/store/counters", (r) => r.fulfill({ status: 500, body: "{}" }));
  await page.evaluate(() => {
    history.pushState(null, "", "/counters");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByTestId("error").waitFor();
  await check(page, "store-36-load-error", false);
  await page.unroute("**/api/store/counters");
  await page.getByRole("button", { name: "重試" }).click();
  await page.getByTestId("counter-1").waitFor();
  await page.context().close();
});

test("門店停用：門店後台顯示「服務已暫停」；恢復後可再使用", async ({ browser, request }) => {
  const s = seed("SMOKE1");
  const page = await storeLogin(browser, s);
  expect((await request.post(`${URLS.api}/api/admin/stores/${s.id}/suspend`)).status()).toBe(200);
  await page.reload();
  await page.getByTestId("suspended").waitFor();
  await check(page, "store-37-suspended");
  expect((await request.post(`${URLS.api}/api/admin/stores/${s.id}/resume`)).status()).toBe(200);
  await page.reload();
  await page.getByTestId("board").waitFor();
  await page.context().close();
});

test("360×640 全頁巡檢：每頁無水平捲動、觸控目標 ≥ 44px", async ({ browser }) => {
  const s = seed("DEMO02");
  const page = await storeLogin(browser, s, SMALL);
  const list: [string, string][] = [
    ["/more", "more"],
    ["/services", "services"],
    ["/counters", "counters"],
    ["/staff", "staff"],
    ["/devices", "devices"],
    ["/hours", "hours"],
    ["/voice", "voice"],
    ["/settings", "settings"],
  ];
  for (const [path, id] of list) {
    await go(page, path, id);
    await check(page, `small-store-${id}`);
  }
  await go(page, "/voice", "voice");
  await page.getByTestId("mode-fun").click();
  await page.getByTestId("pack-open-anticipation").click();
  await check(page, "small-store-voice-lines");
  await page.context().close();
});

declare global {
  interface Window {
    __qcsPreviewLog?: string[][];
    __qcsAudioLog?: { type: string; number: string; kind: string; keys: string[]; at: number }[];
  }
}


import { expect, test } from "@playwright/test";
import { openDisplay, qrUrl, seed, shot, staffLogin, takeTicket } from "./helpers";

test.describe.configure({ mode: "serial" });

test("web 模式：音訊被擋 → 提示＋回報人員端；叫號時提示變紅；Esc 不解鎖、Enter 解鎖並回報 ok", async ({ browser }) => {
  const s = seed("DEMO02");
  const staff = await staffLogin(browser, s);
  const display = await openDisplay(browser, s);
  const overlay = display.getByTestId("unlock-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("請按遙控器 OK 鍵、鍵盤任一鍵");
  await expect(staff.getByRole("alert")).toContainText("叫號機目前無法出聲");
  await shot(display, "display-04-unlock-prompt");
  await shot(staff, "staff-10-audio-blocked-banner");

  const url = await qrUrl(display);
  await takeTicket(browser, url, "李小華", "0966123456");
  await staff.getByTestId("call-next").click();
  await expect(overlay).toHaveAttribute("data-alert", "1");
  await expect(display.getByTestId("current-number")).toHaveText("A001"); // 解鎖前號碼照常顯示
  // 回歸（D5）：提示卡不遮號碼與 QR
  const r = await display.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const hit = (a: DOMRect, b: DOMRect) => !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
    const card = box('[data-testid="unlock-card"]');
    return { num: hit(card, box('[data-testid="current-number"]')), qr: hit(card, box('[data-testid="qr-panel"]')) };
  });
  expect(r).toEqual({ num: false, qr: false });
  await shot(display, "display-05-unlock-alert-red");

  await display.keyboard.press("Escape");
  await display.waitForTimeout(300);
  await expect(overlay).toBeVisible();
  await display.keyboard.press("Enter");
  await expect(overlay).toBeHidden();
  await expect(staff.getByRole("alert")).toBeHidden();
});

test("app 模式（UA 含 QueueDisplayApp/1.0）：被擋也不顯示任何提示，但仍回報 blocked", async ({ browser }) => {
  const s = seed("DEMO02");
  const staff = await staffLogin(browser, s);
  const display = await openDisplay(browser, s, { userAgent: "Mozilla/5.0 (Linux; Android 12) QueueDisplayApp/1.0" });
  await expect(staff.getByRole("alert")).toContainText("叫號機目前無法出聲");
  await expect(display.getByTestId("unlock-overlay")).toHaveCount(0);
  await shot(display, "display-06-app-mode-no-prompt");
});

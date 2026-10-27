import { expect, test } from "@playwright/test";
import { URLS, openDisplay, seed, shot } from "./helpers";

test("停用門店：面板顯示「服務暫停」、QR 區顯示「暫停取號」；恢復後自動重連", async ({ browser, request }) => {
  const s = seed("SMOKE1");
  const display = await openDisplay(browser, s);
  await display.getByTestId("qr-panel").locator("svg").waitFor();
  expect((await request.post(`${URLS.api}/api/admin/stores/${s.id}/suspend`, { headers: { "x-qcs-admin": "1" } })).status()).toBe(200);
  await expect(display.getByTestId("suspended")).toContainText("服務暫停");
  await expect(display.getByTestId("qr-panel")).toContainText("暫停取號");
  await expect(display.getByTestId("qr-panel").locator("svg")).toHaveCount(0);
  await shot(display, "display-07-suspended");
  expect((await request.post(`${URLS.api}/api/admin/stores/${s.id}/resume`, { headers: { "x-qcs-admin": "1" } })).status()).toBe(200);
  await display.reload();
  await expect(display.getByTestId("board")).toBeVisible();
  await display.getByTestId("qr-panel").locator("svg").waitFor();
});

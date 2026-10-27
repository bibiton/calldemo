import { defineConfig } from "@playwright/test";

/**
 * 正式網址 E2E（M6；ADR-049 只有 production）：不起本機伺服器，直接打 https://call-*.jjoy.ai。
 * 前提：已跑 `pnpm seed:demo --env production --confirm`（裝置 token、PIN 讀 ~/.config/queue-call-system/demo-output.json，不在 repo）。
 * 用法：pnpm e2e:prod   截圖輸出 test-results/production/
 */
export default defineConfig({
  testDir: "./production",
  outputDir: "../test-results/playwright-prod",
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", locale: "zh-TW", timezoneId: "Asia/Taipei", browserName: "chromium", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } },
});

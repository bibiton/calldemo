import { defineConfig } from "@playwright/test";

const vite = (app: string, port: number) => ({
  command: `pnpm --filter @qcs/${app} exec vite --port ${port} --strictPort --host 127.0.0.1`,
  url: `http://127.0.0.1:${port}`,
  env: { QCS_API_TARGET: "http://127.0.0.1:8788" },
  reuseExistingServer: false,
  timeout: 60_000,
});

export default defineConfig({
  testDir: ".",
  outputDir: "../test-results/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", locale: "zh-TW", timezoneId: "Asia/Taipei" },
  webServer: [
    { command: "node e2e/start-api.mjs", url: "http://127.0.0.1:8788/health", reuseExistingServer: false, timeout: 120_000, cwd: ".." },
    { ...vite("display", 6174), cwd: ".." },
    { ...vite("customer", 6175), cwd: ".." },
    { ...vite("staff", 6173), cwd: ".." },
    { ...vite("store", 6172), cwd: ".." },
    { ...vite("admin", 6171), cwd: ".." },
  ],
  projects: [
    // 叫號機 kiosk 等同環境：免手勢自動播放（ADR-027 替代方案 C 的旗標）
    { name: "kiosk", testMatch: /main-flow|suspend|store-|pairing|admin|customer-images/, use: { browserName: "chromium", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } } },
    // 一般瀏覽器：需要使用者啟用才能出聲
    { name: "web-blocked", testMatch: /audio-gate/, use: { browserName: "chromium", launchOptions: { args: ["--autoplay-policy=document-user-activation-required"] } } },
    // 通知：用新版 headless Chromium（headless-shell 的 Notification 權限與通知中心行為不完整）。
    // 放在最後跑：main-flow 斷言門店當日第一號是 A001
    { name: "notify", testMatch: /notify/, use: { browserName: "chromium", channel: "chromium" } },
  ],
});

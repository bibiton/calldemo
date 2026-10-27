import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";

// 儲存隔離為「每個測試檔」（官方文件 2026-10-27）；WebSocket 測試每個測試用不同 storeId（＝不同 DO 實例）自行隔離。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml", environment: "local" },
        miniflare: {
          bindings: {
            JWT_SECRET: "test-jwt-secret",
            PHONE_PEPPER: "test-pepper",
            QR_ROOT_SECRET: "test-qr-root",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      testTimeout: 20_000,
    },
  };
});

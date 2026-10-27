import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

/** 測試用 VAPID 金鑰（每次執行隨機產生，不進 git）。 */
function vapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
  return { VAPID_PUBLIC_KEY: pub.toString("base64url"), VAPID_PRIVATE_KEY: j.d, VAPID_SUBJECT: "mailto:test@example.com" };
}

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
            ...vapidKeys(),
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

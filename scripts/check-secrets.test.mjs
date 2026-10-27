import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "./check-secrets.mjs";

test("抓到真值", () => {
  // 測試字串拆開組合：原始碼本身不能長得像密鑰（掃描器也會掃這個檔）
  assert.equal(scan("JWT_SECRET=" + "Zx8f3kQ9vB2nL7wR4tY6uI1oP0aS5dF").length, 1);
  assert.equal(scan("CLOUDFLARE_API_TOKEN=" + '"abcdEFGH1234ijklMNOP5678qrstUVWX90yz"').length, 1);
  assert.equal(scan("-----BEGIN " + "PRIVATE KEY-----").length, 1);
  assert.equal(scan("const t = 'ghp_" + "a".repeat(36) + "'").length, 1);
});

test("佔位字與測試假值不算", () => {
  for (const ok of ["JWT_SECRET=change-me", "JWT_SECRET=", "JWT_SECRET: test-jwt-secret", "CLOUDFLARE_API_TOKEN=<貼上>", "AE_API_TOKEN=$AE_API_TOKEN", "JWT_SECRET: string;"]) {
    assert.deepEqual(scan(ok), [], ok);
  }
});

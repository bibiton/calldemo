import { describe, expect, it } from "vitest";
import {
  QR_WINDOW_MS,
  base32,
  computeQrToken,
  deriveStoreKey,
  qrWindow,
  verifyQrToken,
} from "../src/qr";

const root = "test-root-secret";
const storeId = "st_1";

describe("動態 QR token（04 §7）", () => {
  it("base32 為 RFC 4648 字母表", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  });
  it("window = floor(ms / 120000)", () => {
    expect(qrWindow(0)).toBe(0);
    expect(qrWindow(QR_WINDOW_MS - 1)).toBe(0);
    expect(qrWindow(QR_WINDOW_MS)).toBe(1);
  });
  it("token 為 10 字元、同輸入穩定、不同 window 不同", async () => {
    const key = await deriveStoreKey(root, storeId, 1);
    const a = await computeQrToken(key, storeId, 100);
    expect(a).toMatch(/^[A-Z2-7]{10}$/);
    expect(await computeQrToken(key, storeId, 100)).toBe(a);
    expect(await computeQrToken(key, storeId, 101)).not.toBe(a);
  });
  it("金鑰版本輪替後舊 token 失效", async () => {
    const k1 = await deriveStoreKey(root, storeId, 1);
    const k2 = await deriveStoreKey(root, storeId, 2);
    expect(await computeQrToken(k1, storeId, 5)).not.toBe(await computeQrToken(k2, storeId, 5));
  });
  it("T7：window 與 window-1 通過；window-2 過期；錯 token 無效；未來 window 無效", async () => {
    const key = await deriveStoreKey(root, storeId, 1);
    const now = 1000 * QR_WINDOW_MS + 5_000;
    const w = qrWindow(now);
    const tok = (x: number) => computeQrToken(key, storeId, x);
    expect(await verifyQrToken(key, storeId, w, await tok(w), now)).toBe("ok");
    expect(await verifyQrToken(key, storeId, w - 1, await tok(w - 1), now)).toBe("ok");
    expect(await verifyQrToken(key, storeId, w - 2, await tok(w - 2), now)).toBe("expired");
    expect(await verifyQrToken(key, storeId, w, "AAAAAAAAAA", now)).toBe("invalid");
    expect(await verifyQrToken(key, storeId, w + 1, await tok(w + 1), now)).toBe("invalid");
    expect(await verifyQrToken(key, "st_other", w, await tok(w), now)).toBe("invalid");
  });
});

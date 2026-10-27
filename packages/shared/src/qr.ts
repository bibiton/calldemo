import { hmacSha256, timingSafeEqual } from "./crypto";

/** ADR-012：120 秒一個時間窗，有效 = 現在與前一個窗（120～240 秒）。 */
export const QR_WINDOW_MS = 120_000;
export const QR_TOKEN_LEN = 10;

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}

export function qrWindow(serverNowMs: number): number {
  return Math.floor(serverNowMs / QR_WINDOW_MS);
}

/** storeKey = HMAC(QR_ROOT_SECRET, storeId:version)；由 Worker 計算，經 hello 下發給面板。 */
export function deriveStoreKey(rootSecret: string, storeId: string, version: number): Promise<Uint8Array> {
  return hmacSha256(rootSecret, `${storeId}:${version}`);
}

export async function computeQrToken(storeKey: Uint8Array, storeId: string, window: number): Promise<string> {
  return base32(await hmacSha256(storeKey, `${storeId}:${window}`)).slice(0, QR_TOKEN_LEN);
}

export type QrVerdict = "ok" | "expired" | "invalid";

export async function verifyQrToken(
  storeKey: Uint8Array,
  storeId: string,
  window: number,
  token: string,
  nowMs: number,
): Promise<QrVerdict> {
  if (!Number.isSafeInteger(window) || typeof token !== "string" || token.length !== QR_TOKEN_LEN) return "invalid";
  const cur = qrWindow(nowMs);
  if (window > cur) return "invalid";
  const expected = await computeQrToken(storeKey, storeId, window);
  if (!timingSafeEqual(expected, token.toUpperCase())) return "invalid";
  return window >= cur - 1 ? "ok" : "expired";
}

export function buildQrUrl(base: string, storeCode: string, window: number, token: string): string {
  return `${base.replace(/\/$/, "")}/s/${encodeURIComponent(storeCode)}?w=${window}&k=${token}`;
}

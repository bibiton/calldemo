import { b64decode, b64encode, timingSafeEqual } from "@qcs/shared";

/** Workers 實測上限（M0 0.3，見 06-auth）。 */
export const PBKDF2_ITERATIONS = 100_000;

export async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, 256);
  return new Uint8Array(bits);
}

/** 格式 pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64> */
export async function hashSecret(secret: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(secret, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64encode(salt)}$${b64encode(h)}`;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const p = stored.split("$");
  if (p.length !== 5 || p[0] !== "pbkdf2" || p[1] !== "sha256") return false;
  const iter = Number(p[2]);
  if (!Number.isInteger(iter) || iter < 1 || iter > PBKDF2_ITERATIONS) return false;
  const h = await pbkdf2(secret, b64decode(p[3]), iter);
  return timingSafeEqual(h, b64decode(p[4]));
}

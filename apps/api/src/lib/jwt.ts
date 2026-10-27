import { b64urlDecode, b64urlEncode, timingSafeEqual } from "@qcs/shared";

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, k);
  }
  return k;
}

export interface JwtClaims {
  sub: string;
  role: string;
  store_id: string;
  exp: number; // 秒
  iat?: number;
  tv?: number;
  jti?: string;
  [k: string]: unknown;
}

async function sign(secret: string, data: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(data))));
}

export async function signJwt(secret: string, claims: JwtClaims): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64urlEncode(enc.encode(JSON.stringify(claims)));
  return `${head}.${body}.${await sign(secret, `${head}.${body}`)}`;
}

/** 驗章＋到期；失敗回 null（呼叫端統一回 401）。 */
export async function verifyJwt(secret: string, token: string, nowMs: number): Promise<JwtClaims | null> {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = await sign(secret, `${parts[0]}.${parts[1]}`);
  if (!timingSafeEqual(expected, parts[2])) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (head.alg !== "HS256") return null;
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as JwtClaims;
    if (typeof c.exp !== "number" || c.exp * 1000 <= nowMs) return null;
    return c;
  } catch {
    return null;
  }
}

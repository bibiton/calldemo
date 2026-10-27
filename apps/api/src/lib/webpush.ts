/**
 * Web Push（07-notifications §4）：VAPID（RFC 8292，ES256）＋ payload 加密（RFC 8291／8188 aes128gcm）。
 * 全部 WebCrypto，不引入 Node 套件。只在 q-push consumer 使用（DO 不對外 fetch，ADR-010）。
 */
import { b64urlDecode, b64urlEncode } from "@qcs/shared";

const enc = new TextEncoder();
const RECORD_SIZE = 4096;
/** JWT 有效 12 小時（規範上限），每個 audience 快取 1 小時後重簽。 */
const JWT_TTL_S = 12 * 3600;
const JWT_REUSE_MS = 3600_000;

export interface VapidConfig {
  publicKey: string; // b64url，65 bytes 未壓縮點
  privateKey: string; // b64url，32 bytes（JWK d）
  subject: string; // mailto: 或 https:
}

export interface VapidKeys {
  sign: CryptoKey;
  publicKey: string;
  subject: string;
  cache: Map<string, { jwt: string; until: number }>;
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function cat(...xs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/** workers-types 把 ECDH 的 `public` 標成 `$public`；runtime 依 WebCrypto 規範吃 `public`（測試驗證）。 */
const ecdhParams = (pub: CryptoKey) => ({ name: "ECDH", public: pub }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export async function importVapid(cfg: VapidConfig): Promise<VapidKeys> {
  const pub = b64urlDecode(cfg.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point");
  const sign = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: cfg.privateKey, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: false },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { sign, publicKey: cfg.publicKey, subject: cfg.subject, cache: new Map() };
}

/** VAPID JWT：aud＝push service origin、exp ≤ 12h、sub＝聯絡方式。同 audience 1 小時內重用。 */
export async function vapidJwt(keys: VapidKeys, audience: string, now: number): Promise<string> {
  const hit = keys.cache.get(audience);
  if (hit && hit.until > now) return hit.jwt;
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + JWT_TTL_S, sub: keys.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.sign, enc.encode(`${head}.${body}`)));
  const jwt = `${head}.${body}.${b64urlEncode(sig)}`;
  keys.cache.set(audience, { jwt, until: now + JWT_REUSE_MS });
  return jwt;
}

export interface EncryptOpts {
  /** 測試用：固定 salt 與應用伺服器臨時金鑰（RFC 8291 附錄 A）。 */
  salt?: Uint8Array;
  asKeys?: { privateKey: CryptoKey; publicRaw: Uint8Array };
}

/** RFC 8291：ECDH(P-256) → HKDF(auth) → RFC 8188 aes128gcm 單一 record。 */
export async function encryptAes128gcm(plaintext: Uint8Array, uaPublicB64u: string, authB64u: string, o: EncryptOpts = {}): Promise<Uint8Array> {
  const uaPub = b64urlDecode(uaPublicB64u);
  const auth = b64urlDecode(authB64u);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("p256dh must be a 65-byte uncompressed point");
  if (auth.length !== 16) throw new Error("auth secret must be 16 bytes");
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error("payload too large");

  let as = o.asKeys;
  if (!as) {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    as = { privateKey: kp.privateKey, publicRaw: new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
  }
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(uaKey), as.privateKey, 256));

  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPub, as.publicRaw, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = cat(plaintext, new Uint8Array([2])); // 單一（最後）record 的分隔字元
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = as.publicRaw.length;
  return cat(header, as.publicRaw, ct);
}

export interface PushOpts {
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  topic?: string;
}

export async function buildPushRequest(keys: VapidKeys, sub: Subscription, payload: unknown, o: PushOpts, now = Date.now()): Promise<Request> {
  const url = new URL(sub.endpoint);
  const body = await encryptAes128gcm(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(keys, url.origin, now);
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(o.ttl),
    urgency: o.urgency,
  };
  // Topic：同一號碼的新通知取代尚未送達的舊通知（≤ 32 個 URL-safe 字元）
  if (o.topic) headers.topic = o.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return new Request(sub.endpoint, { method: "POST", headers, body });
}

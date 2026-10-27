import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode } from "@qcs/shared";
import { buildPushRequest, encryptAes128gcm, importVapid, vapidJwt } from "../src/lib/webpush";

// RFC 8291 Appendix A 的測試向量（固定金鑰與 salt → 密文必須逐位元相同）
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

async function ecdhPrivate(dB64u: string, pubB64u: string): Promise<CryptoKey> {
  const pub = b64urlDecode(pubB64u);
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: dB64u, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

/** 使用者代理（瀏覽器）端的解密：獨立實作 RFC 8291／8188，用來驗證加密結果，而不是比對同一份程式。 */
async function uaDecrypt(body: Uint8Array, uaPrivB64u: string, uaPubB64u: string, authB64u: string): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const priv = await ecdhPrivate(uaPrivB64u, uaPubB64u);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, priv, 256));
  const uaPub = b64urlDecode(uaPubB64u);
  const prkKey = await hmac(b64urlDecode(authB64u), ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  expect(pt[end]).toBe(2); // 最後一個 record 的分隔字元
  return dec.decode(pt.slice(0, end));
}

async function newUa() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { pub: b64urlEncode(pub), priv: jwk.d!, auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

async function newVapid() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d!, subject: "mailto:ops@example.com" };
}

describe("Web Push payload 加密（RFC 8291 aes128gcm，WebCrypto）", () => {
  it("RFC 8291 附錄 A 測試向量：密文逐位元相同", async () => {
    const out = await encryptAes128gcm(enc.encode(V.plaintext), V.uaPublic, V.auth, {
      salt: b64urlDecode(V.salt),
      asKeys: { privateKey: await ecdhPrivate(V.asPrivate, V.asPublic), publicRaw: b64urlDecode(V.asPublic) },
    });
    expect(b64urlEncode(out)).toBe(V.body);
  });

  it("隨機金鑰：瀏覽器端獨立解密可還原；每次 salt 與臨時金鑰不同", async () => {
    const ua = await newUa();
    const msg = JSON.stringify({ t: "called", n: "A023", c: 2, url: "/t/x" });
    const a = await encryptAes128gcm(enc.encode(msg), ua.pub, ua.auth);
    const b = await encryptAes128gcm(enc.encode(msg), ua.pub, ua.auth);
    expect(await uaDecrypt(a, ua.priv, ua.pub, ua.auth)).toBe(msg);
    expect(await uaDecrypt(b, ua.priv, ua.pub, ua.auth)).toBe(msg);
    expect(b64urlEncode(a.slice(0, 16))).not.toBe(b64urlEncode(b.slice(0, 16)));
    // header：rs = 4096、keyid 長度 65
    expect(new DataView(a.buffer, a.byteOffset).getUint32(16)).toBe(4096);
    expect(a[20]).toBe(65);
  });

  it("錯誤的訂閱金鑰（長度不對）→ 拋錯，不送出", async () => {
    await expect(encryptAes128gcm(enc.encode("x"), b64urlEncode(new Uint8Array(10)), b64urlEncode(new Uint8Array(16)))).rejects.toThrow();
    const ua = await newUa();
    await expect(encryptAes128gcm(enc.encode("x"), ua.pub, b64urlEncode(new Uint8Array(8)))).rejects.toThrow();
  });
});

describe("VAPID（ES256 JWT）", () => {
  it("JWT 可用公鑰驗章；aud＝endpoint origin、exp ≤ 12 小時、sub＝mailto", async () => {
    const v = await newVapid();
    const keys = await importVapid(v);
    const now = Date.UTC(2026, 9, 27, 4);
    const jwt = await vapidJwt(keys, "https://fcm.googleapis.com", now);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(dec.decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(dec.decode(b64urlDecode(p)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@example.com");
    expect(claims.exp * 1000 - now).toBeLessThanOrEqual(12 * 3600_000);
    expect(claims.exp * 1000).toBeGreaterThan(now);
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(s), enc.encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it("同一 audience 在快取期間重用同一份 JWT（每則推播不重簽）", async () => {
    const keys = await importVapid(await newVapid());
    const now = Date.now();
    expect(await vapidJwt(keys, "https://a.example", now)).toBe(await vapidJwt(keys, "https://a.example", now + 60_000));
    expect(await vapidJwt(keys, "https://b.example", now)).not.toBe(await vapidJwt(keys, "https://a.example", now));
  });
});

describe("推播請求格式", () => {
  it("POST endpoint；Authorization vapid t=,k=；aes128gcm；TTL／Urgency／Topic", async () => {
    const v = await newVapid();
    const ua = await newUa();
    const keys = await importVapid(v);
    const req = await buildPushRequest(
      keys,
      { endpoint: "https://push.example.com/send/abc", p256dh: ua.pub, auth: ua.auth },
      { t: "called", n: "A023", c: 2, url: "/t/01J" },
      { ttl: 120, urgency: "high", topic: "t01J" },
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://push.example.com/send/abc");
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req.headers.get("content-type")).toBe("application/octet-stream");
    expect(req.headers.get("ttl")).toBe("120");
    expect(req.headers.get("urgency")).toBe("high");
    expect(req.headers.get("topic")).toBe("t01J");
    expect(req.headers.get("authorization")).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${v.publicKey}$`));
    const body = new Uint8Array(await req.arrayBuffer());
    expect(body.length).toBeLessThan(4096);
    expect(JSON.parse(await uaDecrypt(body, ua.priv, ua.pub, ua.auth))).toEqual({ t: "called", n: "A023", c: 2, url: "/t/01J" });
  });
});

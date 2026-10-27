/** E2E 用：在 Node 端扮演瀏覽器（使用者代理）解密 Web Push（RFC 8291 aes128gcm），並驗 VAPID JWT。 */
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, type Server } from "node:http";

export function uaKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();

export function decrypt(body: Buffer, ua: ReturnType<typeof uaKeys>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = ua.ecdh.computeSecret(asPub);
  const uaPub = ua.ecdh.getPublicKey();
  const prkKey = hmac(Buffer.from(ua.auth, "base64url"), secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  if (pt[end] !== 2) throw new Error("bad padding delimiter");
  return pt.subarray(0, end).toString("utf8");
}

/** 驗 `Authorization: vapid t=<jwt>, k=<pub>`：ES256 簽章、aud＝endpoint origin。 */
export function verifyVapid(header: string, audience: string): { ok: boolean; claims: any } {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!m) return { ok: false, claims: null };
  const [h, p, s] = m[1].split(".");
  const pub = Buffer.from(m[2], "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  return { ok: ok && claims.aud === audience, claims };
}

export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** 本機假 push service：收下 POST 並回 201。 */
export function fakePushServer(port: number): Promise<{ server: Server; got: Received[] }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, got })));
}

/** 顧客頁的 PushManager 換成假的（headless Chromium 沒有推播服務），endpoint 指向本機假 push service。 */
export function stubPushScript(endpoint: string, keys: { p256dh: string; auth: string }) {
  return `(() => {
    const sub = { endpoint: ${JSON.stringify(endpoint)}, options: { applicationServerKey: null },
      toJSON() { return { endpoint: ${JSON.stringify(endpoint)}, expirationTime: null, keys: ${JSON.stringify(keys)} }; },
      unsubscribe: async () => true };
    if (window.PushManager) {
      PushManager.prototype.subscribe = async function () { window.__qcsSubscribed = (window.__qcsSubscribed || 0) + 1; return sub; };
      PushManager.prototype.getSubscription = async function () { return null; };
    }
  })();`;
}

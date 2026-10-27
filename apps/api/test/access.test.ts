/**
 * M4 4.1：總後台 API 由 Cloudflare Access 保護，Worker 再驗一次 Cf-Access-Jwt-Assertion（06 §1、08 §7）。
 * 兩種模式都要測：本機 DEV_BYPASS_ACCESS（只在 ENV=local 生效）與 Access JWT（RS256＋JWKS＋aud＋iss＋exp）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { b64urlEncode } from "@qcs/shared";
import { env, envWith } from "./test-env";
import { createApp } from "../src/app";
import { resetAccessCache } from "../src/lib/access";
import { seedStore } from "./fixtures";

const TEAM = "qcs-test.cloudflareaccess.com";
const AUD = "aud-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 27, 4, 0);
const enc = new TextEncoder();

async function rsaKey(kid: string) {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { kid, privateKey: kp.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function accessJwt(k: { kid: string; privateKey: CryptoKey }, claims: Record<string, unknown>, head: Record<string, unknown> = {}) {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", kid: k.kid, typ: "JWT", ...head })));
  const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

const good = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  email: "ops@example.com",
  iss: `https://${TEAM}`,
  sub: "user-1",
  type: "app",
  iat: Math.floor(NOW / 1000) - 10,
  exp: Math.floor(NOW / 1000) + 3600,
  ...over,
});

const accessEnv = (over: Record<string, unknown> = {}) =>
  envWith({ ENV: "staging", DEV_BYPASS_ACCESS: undefined, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, ...over });

function setup(keys: { jwk: JsonWebKey }[]) {
  const calls: string[] = [];
  let current = keys;
  const app = createApp({
    now: () => NOW,
    accessFetch: async (url: string) => {
      calls.push(url);
      return { keys: current.map((k) => k.jwk) };
    },
  });
  return {
    calls,
    rotate: (ks: { jwk: JsonWebKey }[]) => (current = ks),
    req: (path: string, init: RequestInit, e: unknown) => app.request(path, init, e as any),
  };
}

// 每個測試產生新的金鑰但沿用 kid "k1"：清掉 isolate 內的 JWKS 快取
beforeEach(() => resetAccessCache());

describe("4.1 本機繞過（DEV_BYPASS_ACCESS）", () => {
  it("ENV=local＋DEV_BYPASS_ACCESS=1 → 以假平台管理員通過", async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request("/api/admin/me", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "dev@local", mode: "dev-bypass" });
  });

  it("旗標在 staging 不生效：沒有 Access JWT → 401", async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request("/api/admin/me", {}, envWith({ ENV: "staging", DEV_BYPASS_ACCESS: "1", ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("production 帶繞過旗標 → 全部請求 500 MISCONFIGURED（拒絕運作）", async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request("/health", {}, envWith({ ENV: "production", DEV_BYPASS_ACCESS: "1" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "MISCONFIGURED" });
  });

  it("非 local 環境缺 ACCESS_AUD／TEAM 設定 → 401（不放行）", async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request("/api/admin/me", {}, envWith({ ENV: "staging", DEV_BYPASS_ACCESS: undefined, ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined }));
    expect(res.status).toBe(401);
  });
});

describe("4.1 Access JWT 驗證（RS256＋JWKS）", () => {
  it("有效 JWT（header）→ 200，身分為 JWT 的 email；只抓一次 certs", async () => {
    const k = await rsaKey("k1");
    const t = setup([k]);
    const token = await accessJwt(k, good());
    for (let i = 0; i < 3; i++) {
      const res = await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": token } }, accessEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ email: "ops@example.com", mode: "access" });
    }
    expect(t.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("aud 為字串也接受；CF_Authorization cookie 也接受", async () => {
    const k = await rsaKey("k1");
    const t = setup([k]);
    const token = await accessJwt(k, good({ aud: AUD }));
    const res = await t.req("/api/admin/me", { headers: { cookie: `x=1; CF_Authorization=${token}` } }, accessEnv());
    expect(res.status).toBe(200);
  });

  const bad: [string, (k: any, other: any) => Promise<string>][] = [
    ["沒有 token", async () => ""],
    ["aud 不符（別的 Access 應用）", (k) => accessJwt(k, good({ aud: ["other-aud"] }))],
    ["iss 不符（別的 team）", (k) => accessJwt(k, good({ iss: "https://evil.cloudflareaccess.com" }))],
    ["已過期", (k) => accessJwt(k, good({ exp: Math.floor(NOW / 1000) - 1 }))],
    ["nbf 在未來", (k) => accessJwt(k, good({ nbf: Math.floor(NOW / 1000) + 600 }))],
    ["沒有 email", (k) => accessJwt(k, good({ email: undefined }))],
    ["簽章用的不是 JWKS 裡的金鑰", (_k, other) => accessJwt({ ...other, kid: "k1" }, good())],
    ["alg=none", async (k) => (await accessJwt(k, good(), { alg: "none" })).split(".").slice(0, 2).join(".") + "."],
    ["alg=HS256（演算法混淆）", (k) => accessJwt(k, good(), { alg: "HS256" })],
    ["格式錯誤", async () => "abc.def"],
  ];
  for (const [name, make] of bad) {
    it(`${name} → 401 ACCESS_REQUIRED`, async () => {
      const k = await rsaKey("k1");
      const other = await rsaKey("k9");
      const t = setup([k]);
      const token = await make(k, other);
      const res = await t.req("/api/admin/me", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} }, accessEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "ACCESS_REQUIRED" });
    });
  }

  it("ACCESS_ALLOWED_EMAILS：名單內 email 通過、名單外（即使 Access 簽發）→ 401；大小寫不敏感", async () => {
    const k = await rsaKey("k1");
    const t = setup([k]);
    const e = accessEnv({ ACCESS_ALLOWED_EMAILS: "Boss@Example.com, ops@example.com" });
    expect((await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k, good({ email: "boss@example.com" })) } }, e)).status).toBe(200);
    expect((await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k, good({ email: "intruder@example.com" })) } }, e)).status).toBe(401);
  });

  it("金鑰輪替：遇到不認得的 kid 會重抓 certs 一次", async () => {
    const k1 = await rsaKey("k1");
    const k2 = await rsaKey("k2");
    const t = setup([k1]);
    expect((await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k1, good()) } }, accessEnv())).status).toBe(200);
    t.rotate([k1, k2]);
    expect((await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k2, good()) } }, accessEnv())).status).toBe(200);
    expect(t.calls.length).toBe(2);
  });

  it("直打其他 /api/admin/* 路由沒有 JWT 也是 401（停用門店不會被執行）", async () => {
    const s = await seedStore();
    const k = await rsaKey("k1");
    const t = setup([k]);
    const res = await t.req(`/api/admin/stores/${s.storeId}/suspend`, { method: "POST", headers: { "x-qcs-admin": "1" } }, accessEnv());
    expect(res.status).toBe(401);
    const row = await env.DB.prepare("SELECT status FROM stores WHERE id=?").bind(s.storeId).first<any>();
    expect(row.status).toBe("active");
  });

  it("稽核紀錄的操作者是 Access email", async () => {
    const s = await seedStore();
    const k = await rsaKey("k1");
    const t = setup([k]);
    const res = await t.req(
      `/api/admin/stores/${s.storeId}/suspend`,
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k, good({ email: "boss@example.com" })), "x-qcs-admin": "1" } },
      accessEnv(),
    );
    expect(res.status).toBe(200);
    const a = await env.DB.prepare("SELECT actor_type, actor_id FROM audit_logs WHERE store_id=? AND action='store.suspend'").bind(s.storeId).first<any>();
    expect(a).toMatchObject({ actor_type: "platform_admin", actor_id: "boss@example.com" });
  });
});

describe("安全審查修正：CSRF、名單為空", () => {
  it("寫入請求沒有 x-qcs-admin 標頭（跨站表單／簡單請求）→ 403 CSRF；跨來源 Origin → 403；同源可", async () => {
    const s = await seedStore();
    const app = createApp({ now: () => NOW });
    const noHdr = await app.request(`/api/admin/stores/${s.storeId}/suspend`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }, env);
    expect(noHdr.status).toBe(403);
    expect(await noHdr.json()).toMatchObject({ code: "CSRF" });
    const evil = await app.request(`/api/admin/stores/${s.storeId}/suspend`, { method: "POST", headers: { "x-qcs-admin": "1", origin: "https://evil.jjoy.ai" } }, env);
    expect(evil.status).toBe(403);
    const ok = await app.request(`http://localhost/api/admin/stores/${s.storeId}/resume`, { method: "POST", headers: { "x-qcs-admin": "1", origin: "http://localhost" } }, env);
    expect(ok.status).toBe(200);
    expect((await app.request("/api/admin/me", {}, env)).status).toBe(200); // GET 不需要
  });

  it("production 沒設定 ACCESS_ALLOWED_EMAILS → 拒絕（不只靠 Access policy）", async () => {
    const k = await rsaKey("k1");
    const t = setup([k]);
    const r = await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k, good()) } }, accessEnv({ ENV: "production", ACCESS_ALLOWED_EMAILS: "" }));
    expect(r.status).toBe(401);
    const r2 = await t.req("/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(k, good()) } }, accessEnv({ ENV: "production", ACCESS_ALLOWED_EMAILS: "ops@example.com" }));
    expect(r2.status).toBe(200);
  });
});

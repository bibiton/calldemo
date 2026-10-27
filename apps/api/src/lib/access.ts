/**
 * 總後台身分（06-auth §1、08 §7）：Cloudflare Access 在前面擋未授權 email；Worker 再驗一次 Access JWT（雙重保險，
 * 即使有人繞過 Access 直打 Worker 也進不去）。
 *
 * - Token：`Cf-Access-Jwt-Assertion` header，或 `CF_Authorization` cookie。
 * - 驗證：RS256；以 `kid` 對應 `https://<team>/cdn-cgi/access/certs` 的 JWK（金鑰每 6 週輪替、舊鑰保留 7 天 → 不寫死，
 *   isolate 內快取 10 分鐘，遇到不認得的 kid 最多每分鐘重抓一次）；`aud` 含 ACCESS_AUD；`iss` = https://<team>；`exp`／`nbf`。
 * - 本機：ENV=local 且 DEV_BYPASS_ACCESS=1 → 假平台管理員 dev@local（production 帶此旗標時整個 Worker 拒絕運作，見 app.ts）。
 */
import { b64urlDecode } from "@qcs/shared";
import type { Env } from "../env";
import { readCookie } from "./admin-auth";

export interface PlatformAdmin {
  email: string;
  mode: "access" | "dev-bypass";
}

export type JwksFetcher = (url: string) => Promise<{ keys: JsonWebKey[] }>;

const JWKS_TTL_MS = 10 * 60_000;
const REFETCH_MIN_MS = 60_000;
const dec = new TextDecoder();

interface JwksEntry {
  at: number;
  /** 上次因「不認得的 kid」重抓的時間：攻擊者亂填 kid 也最多每分鐘觸發一次重抓 */
  missAt: number | null;
  keys: Map<string, Promise<CryptoKey>>;
}
const jwksCache = new Map<string, JwksEntry>();

export const defaultJwksFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url, { cf: { cacheTtl: 300 } } as RequestInit);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  return (await res.json()) as { keys: JsonWebKey[] };
};

async function loadJwks(team: string, fetcher: JwksFetcher, now: number, missAt: number | null): Promise<JwksEntry> {
  const body = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const k of body.keys ?? []) {
    const kid = (k as { kid?: string }).kid;
    if (!kid || k.kty !== "RSA") continue;
    keys.set(kid, crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  const e: JwksEntry = { at: now, missAt, keys };
  jwksCache.set(team, e);
  return e;
}

async function keyFor(team: string, kid: string, fetcher: JwksFetcher, now: number): Promise<CryptoKey | null> {
  let e = jwksCache.get(team);
  if (!e || now - e.at > JWKS_TTL_MS) e = await loadJwks(team, fetcher, now, e?.missAt ?? null);
  else if (!e.keys.has(kid) && (e.missAt === null || now - e.missAt > REFETCH_MIN_MS)) e = await loadJwks(team, fetcher, now, now);
  const k = e.keys.get(kid);
  return k ? await k : null;
}

/** 只在測試間重置用。 */
export function resetAccessCache(): void {
  jwksCache.clear();
}

function json(part: string): any {
  try {
    return JSON.parse(dec.decode(b64urlDecode(part)));
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(env: Env, token: string | null, now: number, fetcher: JwksFetcher): Promise<PlatformAdmin | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  if (!token || !team || !aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[2]) return null;
  const head = json(parts[0]);
  const c = json(parts[1]);
  if (!head || !c || head.alg !== "RS256" || typeof head.kid !== "string") return null;
  let key: CryptoKey | null;
  try {
    key = await keyFor(team, head.kid, fetcher, now);
  } catch (e) {
    console.error("access certs unavailable", String(e));
    return null;
  }
  if (!key) return null;
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(parts[2]);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(aud)) return null;
  if (c.iss !== `https://${team}`) return null;
  const sec = now / 1000;
  if (typeof c.exp !== "number" || c.exp <= sec) return null;
  if (typeof c.nbf === "number" && c.nbf > sec + 60) return null;
  if (typeof c.email !== "string" || !c.email.includes("@")) return null;
  const email = c.email.toLowerCase();
  // 雙重保險：Access policy 已限制名單；Worker 再比一次（ACCESS_ALLOWED_EMAILS，逗號分隔；未設定則以 Access policy 為準）
  const allow = (env.ACCESS_ALLOWED_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(email)) return null;
  return { email, mode: "access" };
}

/** /api/admin/* 的身分：本機繞過或 Access JWT。回 null → 401 ACCESS_REQUIRED。 */
export async function platformAdmin(env: Env, headers: Headers, now: number, fetcher: JwksFetcher): Promise<PlatformAdmin | null> {
  if (env.ENV === "local" && env.DEV_BYPASS_ACCESS === "1") return { email: "dev@local", mode: "dev-bypass" };
  const token = headers.get("cf-access-jwt-assertion") ?? readCookie(headers.get("cookie"), "CF_Authorization");
  return verifyAccessJwt(env, token, now, fetcher);
}

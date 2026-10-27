/**
 * 門店後台身分（06-auth §1）：email＋密碼（PBKDF2）→ access JWT 15 分鐘＋refresh JWT（HttpOnly cookie，14 天）。
 * 撤銷：停用帳號／改密碼 → users.token_version + 1（access 最遲 60 秒快取後失效，refresh 立即失效）。
 */
import type { Env } from "../env";
import { signJwt, verifyJwt, type JwtClaims } from "./jwt";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 14 * 24 * 3600;
export const REFRESH_COOKIE = "qcs_rt";
export const REFRESH_PATH = "/api/store/auth";

const TTL = 60_000;
const cache = new Map<string, { ok: boolean; exp: number; name: string }>();

export interface AdminUser {
  id: string;
  store_id: string;
  display_name: string;
  token_version: number;
}

export async function issueAccess(env: Env, u: AdminUser, now: number) {
  const exp = Math.floor(now / 1000) + ACCESS_TTL_S;
  const accessToken = await signJwt(env.JWT_SECRET, { sub: u.id, role: "store_admin", store_id: u.store_id, tv: u.token_version, name: u.display_name, exp });
  return { accessToken, expiresAt: exp * 1000, user: { id: u.id, displayName: u.display_name } };
}

export function issueRefresh(env: Env, u: AdminUser, now: number): Promise<string> {
  return signJwt(env.JWT_SECRET, { sub: u.id, role: "store_refresh", store_id: u.store_id, tv: u.token_version, exp: Math.floor(now / 1000) + REFRESH_TTL_S });
}

/** Set-Cookie：HttpOnly、SameSite=Strict、只送往 /api/store/auth；本機 http 不加 Secure。 */
export function refreshCookie(env: Env, token: string, maxAge: number): string {
  const secure = env.ENV === "local" ? "" : "; Secure";
  return `${REFRESH_COOKIE}=${token}; Max-Age=${maxAge}; Path=${REFRESH_PATH}; HttpOnly; SameSite=Strict${secure}`;
}

export function readCookie(header: string | undefined | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

async function userOk(env: Env, c: JwtClaims, now: number): Promise<boolean> {
  const k = `${c.sub}:${c.tv}`;
  let e = cache.get(k);
  if (!e || e.exp <= now) {
    const r = await env.DB.prepare("SELECT status, token_version, store_id, display_name FROM users WHERE id=? AND role='store_admin'").bind(c.sub).first<any>();
    e = { ok: !!r && r.status === "active" && r.token_version === c.tv && r.store_id === c.store_id, exp: now + TTL, name: r?.display_name ?? "" };
    cache.set(k, e);
  }
  return e.ok;
}

export async function verifyAdminAccess(env: Env, token: string | null, now: number): Promise<JwtClaims | null> {
  if (!token) return null;
  const c = await verifyJwt(env.JWT_SECRET, token, now);
  if (!c || c.role !== "store_admin") return null;
  return (await userOk(env, c, now)) ? c : null;
}

export async function verifyRefresh(env: Env, token: string | null, now: number): Promise<AdminUser | null> {
  if (!token) return null;
  const c = await verifyJwt(env.JWT_SECRET, token, now);
  if (!c || c.role !== "store_refresh") return null;
  const r = await env.DB.prepare("SELECT id, store_id, display_name, token_version, status FROM users WHERE id=? AND role='store_admin'").bind(c.sub).first<any>();
  if (!r || r.status !== "active" || r.token_version !== c.tv || r.store_id !== c.store_id) return null;
  return r;
}

export function invalidateUserCache(id: string): void {
  for (const k of cache.keys()) if (k.startsWith(id + ":")) cache.delete(k);
}

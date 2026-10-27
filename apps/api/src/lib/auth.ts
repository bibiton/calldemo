import type { Env } from "../env";
import { verifyJwt, type JwtClaims } from "./jwt";

const TTL = 60_000;
const devCache = new Map<string, { ok: boolean; exp: number }>();

export function bearer(h: string | undefined | null): string | null {
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** 從 Sec-WebSocket-Protocol 取 `auth.<token>`（瀏覽器 WebSocket 不能自訂 header，04 §1）。 */
export function protocolToken(h: string | null): string | null {
  if (!h) return null;
  for (const p of h.split(",").map((s) => s.trim())) if (p.startsWith("auth.")) return p.slice(5);
  return null;
}

async function deviceActive(env: Env, id: string, storeId: string, kind: string, tv: number, now: number): Promise<boolean> {
  const k = `${id}:${tv}`;
  const c = devCache.get(k);
  if (c && c.exp > now) return c.ok;
  const r = await env.DB.prepare("SELECT status, token_version, store_id, kind FROM devices WHERE id=?").bind(id).first<any>();
  const ok = !!r && r.status === "active" && r.token_version === tv && r.store_id === storeId && r.kind === kind;
  devCache.set(k, { ok, exp: now + TTL });
  return ok;
}

export function invalidateDevice(id: string): void {
  for (const k of devCache.keys()) if (k.startsWith(id + ":")) devCache.delete(k);
}

/** display／staff_device token：簽章＋到期＋D1 裝置仍 active 且 token_version 相符（解除配對即失效）。 */
export async function verifyDeviceToken(env: Env, token: string | null, kind: "display" | "staff_device", now: number): Promise<JwtClaims | null> {
  if (!token) return null;
  const c = await verifyJwt(env.JWT_SECRET, token, now);
  if (!c || c.role !== kind) return null;
  return (await deviceActive(env, c.sub, c.store_id, kind, c.tv ?? 1, now)) ? c : null;
}

const userCache = new Map<string, { ok: boolean; exp: number }>();

export async function verifyStaffToken(env: Env, token: string | null, now: number): Promise<JwtClaims | null> {
  if (!token) return null;
  const c = await verifyJwt(env.JWT_SECRET, token, now);
  if (!c || c.role !== "staff") return null;
  const k = `${c.sub}:${c.tv}`;
  let e = userCache.get(k);
  if (!e || e.exp <= now) {
    const r = await env.DB.prepare("SELECT status, token_version, store_id FROM users WHERE id=? AND role='staff'").bind(c.sub).first<any>();
    e = { ok: !!r && r.status === "active" && r.token_version === c.tv && r.store_id === c.store_id, exp: now + TTL };
    userCache.set(k, e);
  }
  if (!e.ok) return null;
  if (typeof c.did === "string" && !(await deviceActive(env, c.did, c.store_id, "staff_device", Number(c.dtv ?? 1), now))) return null;
  return c;
}

export async function verifyTicketToken(env: Env, token: string | null, now: number): Promise<JwtClaims | null> {
  if (!token) return null;
  const c = await verifyJwt(env.JWT_SECRET, token, now);
  return c && c.role === "customer" ? c : null;
}

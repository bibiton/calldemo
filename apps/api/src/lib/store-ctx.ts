import { b64encode, deriveStoreKey, type StoreInfo } from "@qcs/shared";
import type { Env } from "../env";
import type { License, StoreCtx } from "../do/store-queue";

/** KV `license:<id>` 的內容：開通狀態＋設定摘要（03 §2）。 */
export interface StoreRecord {
  store: StoreInfo;
  license: License;
  qrKeyVersion: number;
  maxDevices: number;
  v: number;
}

const TTL_MS = 60_000;
const mem = new Map<string, { rec: StoreRecord; exp: number }>();
const codeMem = new Map<string, { id: string; exp: number }>();

export function invalidateStore(storeId: string): void {
  mem.delete(storeId);
}

/** isolate 記憶體（60 秒）→ KV（cacheTtl 60）→ D1 並回填 KV（ADR-011）。 */
export async function loadStore(env: Env, storeId: string, now = Date.now()): Promise<StoreRecord | null> {
  const m = mem.get(storeId);
  if (m && m.exp > now) return m.rec;
  let rec = (await env.LICENSE.get<StoreRecord>(`license:${storeId}`, { type: "json", cacheTtl: 60 })) ?? null;
  if (!rec) {
    rec = await readStoreFromD1(env, storeId);
    if (!rec) return null;
    await env.LICENSE.put(`license:${storeId}`, JSON.stringify(rec));
  }
  mem.set(storeId, { rec, exp: now + TTL_MS });
  return rec;
}

export async function refreshStore(env: Env, storeId: string): Promise<StoreRecord | null> {
  invalidateStore(storeId);
  const rec = await readStoreFromD1(env, storeId);
  if (rec) await env.LICENSE.put(`license:${storeId}`, JSON.stringify(rec));
  return rec;
}

export async function storeIdByCode(env: Env, code: string, now = Date.now()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(code)) return null;
  const c = codeMem.get(code);
  if (c && c.exp > now) return c.id;
  let id = await env.LICENSE.get(`storecode:${code}`, { cacheTtl: 60 });
  if (!id) {
    const r = await env.DB.prepare("SELECT id FROM stores WHERE code=?").bind(code).first<{ id: string }>();
    if (!r) return null;
    id = r.id;
    await env.LICENSE.put(`storecode:${code}`, id);
  }
  codeMem.set(code, { id, exp: now + TTL_MS });
  return id;
}

async function readStoreFromD1(env: Env, storeId: string): Promise<StoreRecord | null> {
  const [s, svcs, ctrs] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM stores WHERE id=?").bind(storeId),
    env.DB.prepare("SELECT id,name,prefix,sort_order FROM services WHERE store_id=? AND enabled=1 ORDER BY sort_order, prefix").bind(storeId),
    env.DB.prepare("SELECT id,name,number,service_ids FROM counters WHERE store_id=? AND enabled=1 ORDER BY number").bind(storeId),
  ]);
  const row = s.results[0] as any;
  if (!row) return null;
  const parse = (x: string, d: any) => {
    try {
      return JSON.parse(x);
    } catch {
      return d;
    }
  };
  return {
    store: {
      id: row.id,
      code: row.code,
      name: row.name,
      logoUrl: row.logo_r2_key ? `${env.MEDIA_BASE}/${row.logo_r2_key}` : null,
      timezone: row.timezone,
      businessHours: parse(row.business_hours, []),
      features: parse(row.features, {}),
      voiceSettings: parse(row.voice_settings, {}),
      notifyAhead: row.notify_ahead ?? 3,
      services: (svcs.results as any[]).map((x) => ({ id: x.id, name: x.name, prefix: x.prefix, sortOrder: x.sort_order })),
      counters: (ctrs.results as any[]).map((x) => ({ id: x.id, name: x.name, number: x.number, serviceIds: parse(x.service_ids, []) })),
    },
    license: { status: row.status, expiresAt: row.expires_at },
    qrKeyVersion: row.qr_key_version,
    maxDevices: row.max_devices,
    v: row.updated_at,
  };
}

export function licenseError(rec: StoreRecord, now: number): "STORE_SUSPENDED" | "STORE_EXPIRED" | null {
  if (rec.license.status !== "active") return "STORE_SUSPENDED";
  if (rec.license.expiresAt != null && rec.license.expiresAt < now) return "STORE_EXPIRED";
  return null;
}

/** DO 看到的 license：到期已由 Worker 判斷並轉成 suspended 以外的狀態時，DO 自己也會比對 expiresAt。 */
export async function toCtx(env: Env, rec: StoreRecord, withQr: boolean): Promise<StoreCtx> {
  const ctx: StoreCtx = { store: rec.store, license: rec.license };
  if (withQr) {
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, rec.store.id, rec.qrKeyVersion);
    ctx.qr = { keyB64: b64encode(key), keyVersion: rec.qrKeyVersion, windowSec: 120, baseUrl: env.CUSTOMER_BASE_URL };
  }
  return ctx;
}

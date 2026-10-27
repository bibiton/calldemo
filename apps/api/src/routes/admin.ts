/**
 * 總後台 API（05-apps §5、06-auth §2）：/api/admin/*，由 Cloudflare Access 保護（lib/access.ts）。
 * 只看主檔、授權、計量與稽核；**不回傳任何顧客個資**（06 §5：平台管理員看不到姓名／手機原文）。
 * 每個寫入：同一個 D1 batch（變更＋stores.updated_at 遞增＋audit_logs）→ 回填 KV → 通知 DO（停用即斷線、設定即時套用）。
 */
import { Hono } from "hono";
import { ulid } from "@qcs/shared";
import type { Env } from "../env";
import { hashSecret } from "../lib/password";
import { invalidateDevice, invalidateStaff } from "../lib/auth";
import { invalidateUserCache } from "../lib/admin-auth";
import { licenseError, refreshStore, toCtx } from "../lib/store-ctx";
import { storeAlerts } from "../usage/alerts";
import { ensureDaily } from "../usage/rollup";
import { err, isInt, isStr, type AppEnv, type C, type Deps } from "./common";
import { registerUsageRoutes } from "./admin-usage";
import type { AeFetch } from "../usage/ae";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I、O、0、1（易混淆）
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const FEATURE_KEYS = ["push", "ads", "voice", "showMaskedName", "internal"] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_QUOTA = 10 * 1024 ** 3;

const randomFrom = (alphabet: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => alphabet[x % alphabet.length]).join("");
export const newPassword = () => randomFrom(PW_ALPHABET, 12);

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type StoreStatus = "active" | "suspended" | "expired" | "deleted";
export function effectiveStatus(row: { status: string; expires_at: number | null; deleted_at?: number | null }, now: number): StoreStatus {
  if (row.deleted_at) return "deleted";
  if (row.status !== "active") return "suspended";
  if (row.expires_at != null && row.expires_at < now) return "expired";
  return "active";
}

const parseJson = (s: string | null, d: any) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

function storeOut(r: any, now: number) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    brandId: r.brand_id,
    brandName: r.brand_name ?? null,
    status: effectiveStatus(r, now),
    rawStatus: r.status,
    expiresAt: r.expires_at,
    deletedAt: r.deleted_at ?? null,
    timezone: r.timezone,
    maxDevices: r.max_devices,
    maxStaff: r.max_staff,
    adQuotaBytes: r.ad_quota_bytes,
    features: parseJson(r.features, {}),
    createdAt: r.created_at,
  };
}

export function adminRoutes(deps: Deps & { aeFetch: AeFetch }) {
  const r = new Hono<AppEnv>();
  registerUsageRoutes(r, deps);
  const { now } = deps;
  const actor = (c: C) => c.get("platform").email;

  const audit = (c: C, storeId: string | null, action: string, target: string | null, detail: unknown = null) =>
    c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target,detail) VALUES(?,?,?,?,?,?,?,?)").bind(
      ulid(now()),
      now(),
      "platform_admin",
      actor(c),
      storeId,
      action,
      target,
      detail == null ? null : JSON.stringify(detail),
    );

  const bump = (c: C, id: string) => c.env.DB.prepare("UPDATE stores SET updated_at=MAX(updated_at+1, ?) WHERE id=?").bind(now(), id);

  /** 寫入後同步：KV 回填；停用／到期 → DO.suspend（立即斷線）；否則 DO 套用新設定並廣播 settings.changed。 */
  async function sync(c: C, id: string) {
    const rec = (await refreshStore(c.env, id))!;
    const le = licenseError(rec, now());
    const stub = deps.stub(c, id);
    if (le) await stub.suspend(le === "STORE_EXPIRED" ? "expired" : "suspended", rec.license);
    else await stub.configChanged(await toCtx(c.env, rec, true));
    return rec;
  }

  const storeRow = (c: C, id: string) =>
    c.env.DB.prepare("SELECT s.*, b.name AS brand_name FROM stores s LEFT JOIN brands b ON b.id=s.brand_id WHERE s.id=?").bind(id).first<any>();

  r.get("/me", (c) => c.json(c.get("platform")));

  // ---------- 品牌 ----------
  r.get("/brands", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT b.id, b.name, b.created_at, (SELECT count(*) FROM stores s WHERE s.brand_id=b.id AND s.deleted_at IS NULL) AS stores FROM brands b ORDER BY b.created_at, b.id",
    ).all<any>();
    return c.json({ brands: rows.results.map((b) => ({ id: b.id, name: b.name, stores: b.stores, createdAt: b.created_at })) });
  });
  r.post("/brands", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!isStr(b?.name, 1, 40)) return err(c, 422, "INVALID");
    const id = ulid(now());
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO brands(id,name,created_at,updated_at) VALUES(?,?,?,?)").bind(id, b.name.trim(), now(), now()),
      audit(c, null, "brand.create", id, { name: b.name.trim() }),
    ]);
    return c.json({ brand: { id, name: b.name.trim(), stores: 0 } });
  });
  r.put("/brands/:id", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!isStr(b?.name, 1, 40)) return err(c, 422, "INVALID");
    const id = c.req.param("id");
    const [u] = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE brands SET name=?, updated_at=? WHERE id=?").bind(b.name.trim(), now(), id),
      audit(c, null, "brand.update", id, { name: b.name.trim() }),
    ]);
    if (!u.meta.changes) return err(c, 404, "NOT_FOUND");
    return c.json({ ok: true });
  });
  r.delete("/brands/:id", async (c) => {
    const id = c.req.param("id");
    const n = (await c.env.DB.prepare("SELECT count(*) AS n FROM stores WHERE brand_id=?").bind(id).first<{ n: number }>())!.n;
    if (n) return err(c, 409, "BRAND_IN_USE", { stores: n });
    const [d] = await c.env.DB.batch([c.env.DB.prepare("DELETE FROM brands WHERE id=?").bind(id), audit(c, null, "brand.delete", id)]);
    if (!d.meta.changes) return err(c, 404, "NOT_FOUND");
    return c.json({ ok: true });
  });

  // ---------- 門店列表 ----------
  r.get("/stores", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 40);
    const status = c.req.query("status") ?? "all";
    const where = [status === "deleted" ? "s.deleted_at IS NOT NULL" : "s.deleted_at IS NULL"];
    const binds: unknown[] = [];
    if (q) {
      // % 與 _ 當一般字元
      const esc = (x: string) => x.replace(/[\\%_]/g, (m) => "\\" + m);
      where.push("(s.name LIKE ? ESCAPE '\\' OR s.code LIKE ? ESCAPE '\\')");
      binds.push(`%${esc(q)}%`, `%${esc(q.toUpperCase())}%`);
    }
    const month = new Date(now()).toISOString().slice(0, 7);
    // 本月成本與警示要用到的日彙總（缺的過去日子補算；已算過的不重算）
    const from = [`${month}-01`, new Date(now() - 8 * 86400_000).toISOString().slice(0, 10)].sort()[0];
    await ensureDaily(c.env, from, new Date(now()).toISOString().slice(0, 10), now());
    const rows = await c.env.DB.prepare(
      `SELECT s.*, b.name AS brand_name,
        (SELECT count(*) FROM devices d WHERE d.store_id=s.id AND d.kind='display' AND d.status='active') AS displays,
        (SELECT SUM(est_cost_usd) FROM usage_daily u WHERE u.store_id=s.id AND u.date LIKE ?) AS month_est,
        (SELECT allocated_cost_usd FROM usage_monthly m WHERE m.store_id=s.id AND m.month=?) AS month_alloc
       FROM stores s LEFT JOIN brands b ON b.id=s.brand_id WHERE ${where.join(" AND ")} ORDER BY s.created_at, s.id LIMIT 500`,
    ).bind(`${month}-%`, month, ...binds).all<any>();
    let list = rows.results.map((x) => ({ ...storeOut(x, now()), displays: x.displays, monthEstUsd: x.month_est ?? 0, monthAllocatedUsd: x.month_alloc ?? null }));
    if (["active", "suspended", "expired"].includes(status)) list = list.filter((s) => s.status === status);
    const alerts = await storeAlerts(c.env, list.map((s) => s.id), now());
    // 有紅色警示的排最前、再來黃色，其餘依門店碼
    const rank = (id: string) => (alerts.get(id) ?? []).reduce((a, x) => Math.max(a, x.level === "red" ? 2 : 1), 0);
    list.sort((a, b) => rank(b.id) - rank(a.id) || a.code.localeCompare(b.code));
    return c.json({ stores: list.map((s) => ({ ...s, alerts: alerts.get(s.id) ?? [] })), month });
  });

  // ---------- 建立門店 ----------
  r.post("/stores", async (c) => {
    const b = await c.req.json().catch(() => null);
    const v = storeInput(b ?? {}, true);
    if (!v || !isStr(b?.admin?.displayName, 1, 20) || typeof b?.admin?.email !== "string" || !EMAIL.test(b.admin.email.trim())) return err(c, 422, "INVALID");
    const brandId = typeof b.brandId === "string" && b.brandId ? b.brandId : "brand_default";
    if (!(await c.env.DB.prepare("SELECT id FROM brands WHERE id=?").bind(brandId).first())) {
      if (brandId !== "brand_default") return err(c, 422, "BRAND_INVALID");
      await c.env.DB.prepare("INSERT OR IGNORE INTO brands(id,name,created_at,updated_at) VALUES('brand_default','預設品牌',?,?)").bind(now(), now()).run();
    }
    let code: string;
    if (b.code === undefined || b.code === null || b.code === "") code = randomFrom(CODE_ALPHABET, 6);
    else if (typeof b.code === "string" && /^[A-Za-z0-9]{4,8}$/.test(b.code)) code = b.code.toUpperCase();
    else return err(c, 422, "INVALID");
    const email = b.admin.email.trim().toLowerCase();
    if (await c.env.DB.prepare("SELECT id FROM stores WHERE code=?").bind(code).first()) return err(c, 409, "CODE_TAKEN");
    if (await c.env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first()) return err(c, 409, "EMAIL_TAKEN");
    const id = ulid(now());
    const uid = ulid(now());
    const password = newPassword();
    const features = { push: true, ads: true, voice: true, showMaskedName: false, ...(v.features ?? {}) };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO stores(id,brand_id,code,name,status,expires_at,max_devices,max_staff,ad_quota_bytes,features,timezone,business_hours,voice_settings,created_at,updated_at)
           VALUES(?,?,?,?,'active',?,?,?,?,?,?,'[]','{}',?,?)`,
        ).bind(id, brandId, code, v.name, v.expiresAt ?? null, v.maxDevices ?? 2, v.maxStaff ?? 10, v.adQuotaBytes ?? 524288000, JSON.stringify(features), v.timezone, now(), now()),
        c.env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(
          uid, "store_admin", id, b.admin.displayName.trim(), email, await hashSecret(password), now(), now(),
        ),
        audit(c, id, "store.create", id, { code, name: v.name }),
        audit(c, id, "user.create", uid, { role: "store_admin", email }),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return err(c, 409, /code/i.test(String(e)) ? "CODE_TAKEN" : "EMAIL_TAKEN");
      throw e;
    }
    await c.env.LICENSE.put(`storecode:${code}`, id);
    await refreshStore(c.env, id);
    c.header("cache-control", "no-store");
    return c.json({ store: storeOut(await storeRow(c, id), now()), admin: { id: uid, email, displayName: b.admin.displayName.trim(), initialPassword: password } });
  });

  // ---------- 門店詳情 ----------
  r.get("/stores/:id", async (c) => {
    const id = c.req.param("id");
    const s = await storeRow(c, id);
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    const [admins, devices, counts, ads] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT id, email, display_name, status, locked_until, created_at FROM users WHERE store_id=? AND role='store_admin' ORDER BY created_at").bind(id),
      c.env.DB.prepare("SELECT id, kind, name, client_kind, audio_status, audio_status_at, created_at FROM devices WHERE store_id=? AND status='active' ORDER BY kind, created_at").bind(id),
      c.env.DB.prepare(
        "SELECT (SELECT count(*) FROM users WHERE store_id=?1 AND role='staff' AND status='active') AS staff, (SELECT count(*) FROM services WHERE store_id=?1) AS services, (SELECT count(*) FROM counters WHERE store_id=?1) AS counters",
      ).bind(id),
      c.env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM ad_assets WHERE owner_type='store' AND owner_id=? AND status='ready'").bind(id),
    ]);
    // 面板在線：直接問 DO（管理員開詳情才喚醒一次，不輪詢）
    let live: { deviceId: string | null; audio: string | null; client: string | null }[] | null = null;
    try {
      live = await deps.stub(c, id).liveDevices();
    } catch (e) {
      console.error("liveDevices failed", id, String(e));
    }
    const alerts = (await storeAlerts(c.env, [id], now())).get(id) ?? [];
    return c.json({
      store: storeOut(s, now()),
      admins: (admins.results as any[]).map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, status: u.status, locked: !!u.locked_until && u.locked_until > now(), createdAt: u.created_at })),
      devices: (devices.results as any[]).map((d) => ({ id: d.id, kind: d.kind, name: d.name, client: d.client_kind, audio: d.audio_status, audioAt: d.audio_status_at, createdAt: d.created_at })),
      counts: counts.results[0],
      adBytes: (ads.results[0] as any).b,
      live,
      alerts,
    });
  });

  // ---------- 修改：名稱／時區／品牌／到期／上限／功能開關／廣告容量 ----------
  r.put("/stores/:id", async (c) => {
    const id = c.req.param("id");
    const s = await storeRow(c, id);
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    if (s.deleted_at) return err(c, 409, "STORE_DELETED");
    const b = await c.req.json().catch(() => null);
    const v = storeInput(b ?? {}, false);
    if (!v) return err(c, 422, "INVALID");
    if (v.brandId && !(await c.env.DB.prepare("SELECT id FROM brands WHERE id=?").bind(v.brandId).first())) return err(c, 422, "BRAND_INVALID");
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (col: string, val: unknown) => (sets.push(`${col}=?`), binds.push(val));
    if (v.name !== undefined) set("name", v.name);
    if (v.timezone !== undefined) set("timezone", v.timezone);
    if (v.brandId !== undefined) set("brand_id", v.brandId);
    if (v.expiresAt !== undefined) set("expires_at", v.expiresAt);
    if (v.maxDevices !== undefined) set("max_devices", v.maxDevices);
    if (v.maxStaff !== undefined) set("max_staff", v.maxStaff);
    if (v.adQuotaBytes !== undefined) set("ad_quota_bytes", v.adQuotaBytes);
    if (v.features !== undefined) set("features", JSON.stringify({ ...parseJson(s.features, {}), ...v.features }));
    if (!sets.length) return err(c, 422, "INVALID");
    const stmts = [c.env.DB.prepare(`UPDATE stores SET ${sets.join(", ")} WHERE id=?`).bind(...binds, id), bump(c, id)];
    const { expiresAt, ...rest } = v;
    if (expiresAt !== undefined) stmts.push(audit(c, id, "store.extend", id, { from: s.expires_at, to: expiresAt }));
    if (Object.keys(rest).length) stmts.push(audit(c, id, "store.update", id, rest));
    await c.env.DB.batch(stmts);
    await sync(c, id);
    return c.json({ store: storeOut(await storeRow(c, id), now()) });
  });

  async function setStatus(c: C, status: "active" | "suspended") {
    const id = c.req.param("id")!;
    const s = await storeRow(c, id);
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    if (s.deleted_at) return err(c, 409, "STORE_DELETED");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE stores SET status=? WHERE id=?").bind(status, id),
      bump(c, id),
      audit(c, id, status === "active" ? "store.resume" : "store.suspend", id),
    ]);
    await sync(c, id);
    return c.json({ ok: true, status });
  }
  r.post("/stores/:id/suspend", (c) => setStatus(c, "suspended"));
  r.post("/stores/:id/resume", (c) => setStatus(c, "active"));

  // ---------- 刪除＝封存（ADR-043）----------
  r.delete("/stores/:id", async (c) => {
    const id = c.req.param("id");
    const s = await storeRow(c, id);
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    if (s.deleted_at) return c.json({ ok: true });
    const b = await c.req.json().catch(() => null);
    if (String(b?.confirmCode ?? "").toUpperCase() !== s.code) return err(c, 422, "CONFIRM_MISMATCH");
    const users = await c.env.DB.prepare("SELECT id FROM users WHERE store_id=?").bind(id).all<{ id: string }>();
    const devs = await c.env.DB.prepare("SELECT id FROM devices WHERE store_id=? AND status='active'").bind(id).all<{ id: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE stores SET status='suspended', deleted_at=? WHERE id=?").bind(now(), id),
      c.env.DB.prepare("UPDATE users SET status='disabled', token_version=token_version+1, updated_at=? WHERE store_id=?").bind(now(), id),
      c.env.DB.prepare("UPDATE devices SET status='revoked', token_version=token_version+1 WHERE store_id=? AND status='active'").bind(id),
      bump(c, id),
      audit(c, id, "store.delete", id, { code: s.code, name: s.name }),
    ]);
    for (const u of users.results) {
      invalidateStaff(u.id);
      invalidateUserCache(u.id);
    }
    for (const d of devs.results) invalidateDevice(d.id);
    await sync(c, id);
    return c.json({ ok: true });
  });

  // ---------- 店長帳號 ----------
  r.post("/stores/:id/admins", async (c) => {
    const id = c.req.param("id");
    const s = await storeRow(c, id);
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    if (s.deleted_at) return err(c, 409, "STORE_DELETED");
    const b = await c.req.json().catch(() => null);
    if (!isStr(b?.displayName, 1, 20) || typeof b?.email !== "string" || !EMAIL.test(b.email.trim())) return err(c, 422, "INVALID");
    const email = b.email.trim().toLowerCase();
    if (await c.env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first()) return err(c, 409, "EMAIL_TAKEN");
    const uid = ulid(now());
    const password = newPassword();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(
        uid, "store_admin", id, b.displayName.trim(), email, await hashSecret(password), now(), now(),
      ),
      audit(c, id, "user.create", uid, { role: "store_admin", email }),
    ]);
    c.header("cache-control", "no-store");
    return c.json({ admin: { id: uid, email, displayName: b.displayName.trim(), status: "active", initialPassword: password } });
  });

  const adminRow = (c: C) =>
    c.env.DB.prepare("SELECT u.id, u.status, s.deleted_at FROM users u JOIN stores s ON s.id=u.store_id WHERE u.id=? AND u.store_id=? AND u.role='store_admin'")
      .bind(c.req.param("uid"), c.req.param("id"))
      .first<any>();

  r.post("/stores/:id/admins/:uid/reset-password", async (c) => {
    const u = await adminRow(c);
    if (!u) return err(c, 404, "NOT_FOUND");
    if (u.deleted_at) return err(c, 409, "STORE_DELETED");
    const password = newPassword();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash=?, token_version=token_version+1, failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?").bind(await hashSecret(password), now(), u.id),
      audit(c, c.req.param("id"), "user.reset", u.id),
    ]);
    invalidateUserCache(u.id);
    c.header("cache-control", "no-store");
    return c.json({ password });
  });

  for (const [path, status, action] of [["disable", "disabled", "user.disable"], ["enable", "active", "user.enable"]] as const) {
    r.post(`/stores/:id/admins/:uid/${path}`, async (c) => {
      const u = await adminRow(c);
      if (!u) return err(c, 404, "NOT_FOUND");
      if (u.deleted_at && status === "active") return err(c, 409, "STORE_DELETED");
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET status=?, token_version=token_version+1, updated_at=? WHERE id=?").bind(status, now(), u.id),
        audit(c, c.req.param("id"), action, u.id),
      ]);
      invalidateUserCache(u.id);
      return c.json({ ok: true });
    });
  }

  // ---------- 稽核 ----------
  r.get("/audit", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
    const where: string[] = [];
    const binds: unknown[] = [];
    const storeId = c.req.query("storeId");
    const action = c.req.query("action");
    const before = c.req.query("before");
    if (storeId) where.push("a.store_id=?"), binds.push(storeId);
    if (action) {
      if (action.endsWith(".*")) where.push("a.action LIKE ?"), binds.push(action.slice(0, -1) + "%");
      else where.push("a.action=?"), binds.push(action);
    }
    if (before) {
      const [at, id] = before.split("_");
      if (!/^\d+$/.test(at ?? "") || !id) return err(c, 422, "INVALID");
      where.push("(a.at < ? OR (a.at = ? AND a.id < ?))"), binds.push(Number(at), Number(at), id);
    }
    const rows = await c.env.DB.prepare(
      `SELECT a.*, s.name AS store_name, s.code AS store_code FROM audit_logs a LEFT JOIN stores s ON s.id=a.store_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.at DESC, a.id DESC LIMIT ?`,
    ).bind(...binds, limit + 1).all<any>();
    const items = rows.results.slice(0, limit).map((a) => ({
      id: a.id,
      at: a.at,
      actorType: a.actor_type,
      actorId: a.actor_id,
      storeId: a.store_id,
      storeName: a.store_name,
      storeCode: a.store_code,
      action: a.action,
      target: a.target,
      detail: parseJson(a.detail, null),
    }));
    const last = items.at(-1);
    return c.json({ items, next: rows.results.length > limit && last ? `${last.at}_${last.id}` : null });
  });

  return r;
}

interface StoreInput {
  name?: string;
  timezone?: string;
  brandId?: string;
  expiresAt?: number | null;
  maxDevices?: number;
  maxStaff?: number;
  adQuotaBytes?: number;
  features?: Record<string, boolean>;
}

/** 建立（create=true：name、timezone 必填）或部分更新。任一欄位不合法 → null（整筆拒絕，不部分寫入）。 */
function storeInput(b: any, create: boolean): StoreInput | null {
  const v: StoreInput = {};
  if (b.name !== undefined || create) {
    if (!isStr(b.name, 1, 40)) return null;
    v.name = b.name.trim();
  }
  if (b.timezone !== undefined || create) {
    if (!validTimezone(b.timezone)) return null;
    v.timezone = b.timezone;
  }
  if (b.brandId !== undefined && !create) {
    if (typeof b.brandId !== "string" || !b.brandId) return null;
    v.brandId = b.brandId;
  }
  if (b.expiresAt !== undefined) {
    if (b.expiresAt !== null && !isInt(b.expiresAt, 0, 8_640_000_000_000_000)) return null;
    v.expiresAt = b.expiresAt;
  }
  if (b.maxDevices !== undefined) {
    if (!isInt(b.maxDevices, 0, 50)) return null;
    v.maxDevices = b.maxDevices;
  }
  if (b.maxStaff !== undefined) {
    if (!isInt(b.maxStaff, 1, 200)) return null;
    v.maxStaff = b.maxStaff;
  }
  if (b.adQuotaBytes !== undefined) {
    if (!isInt(b.adQuotaBytes, 0, MAX_QUOTA)) return null;
    v.adQuotaBytes = b.adQuotaBytes;
  }
  if (b.features !== undefined) {
    if (!b.features || typeof b.features !== "object" || Array.isArray(b.features)) return null;
    const f: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(b.features)) {
      if (!(FEATURE_KEYS as readonly string[]).includes(k)) continue;
      if (typeof val !== "boolean") return null;
      f[k] = val;
    }
    v.features = f;
  }
  return v;
}

export type { Env };

/**
 * 門店後台 API（05-apps §4、06-auth）：/api/store/*。
 * 每個寫入都在同一個 D1 batch 內：資料變更＋stores.updated_at 遞增＋audit_logs；之後回填 KV 並通知 DO（settings.changed）。
 */
import { Hono } from "hono";
import { ulid } from "@qcs/shared";
import { normalizeVoiceSettings } from "@qcs/shared/voice/settings";
import { verifySecret, hashSecret } from "../lib/password";
import { bearer, invalidateStaff } from "../lib/auth";
import { issueAccess, issueRefresh, readCookie, refreshCookie, REFRESH_COOKIE, REFRESH_TTL_S, verifyAdminAccess, verifyRefresh, invalidateUserCache } from "../lib/admin-auth";
import { licenseError, loadStore, refreshStore, toCtx, type StoreRecord } from "../lib/store-ctx";
import { err, HHMM, isInt, isStr, type AppEnv, type C, type Deps } from "./common";
import { registerDeviceRoutes } from "./pairing";
import { registerAdRoutes } from "./ads";

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const PREFIX = /^[A-Z]{1,2}$/;

const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

export function storeAdminRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const { now } = deps;

  const audit = (c: C, storeId: string, actorId: string, action: string, target: string | null, detail: unknown = null) =>
    c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target,detail) VALUES(?,?,?,?,?,?,?,?)").bind(
      ulid(now()),
      now(),
      "store_admin",
      actorId,
      storeId,
      action,
      target,
      detail == null ? null : JSON.stringify(detail),
    );

  /** 寫入門店設定的共同路徑：batch（變更＋版本遞增＋稽核）→ 回填 KV → DO 廣播 settings.changed。 */
  async function change(c: C, stmts: D1PreparedStatement[], action: string, target: string | null, detail: unknown = null): Promise<StoreRecord> {
    const a = c.get("admin");
    await c.env.DB.batch([
      ...stmts,
      c.env.DB.prepare("UPDATE stores SET updated_at=MAX(updated_at+1, ?) WHERE id=?").bind(now(), a.store_id),
      audit(c, a.store_id, a.sub, action, target, detail),
    ]);
    const rec = (await refreshStore(c.env, a.store_id))!;
    await deps.stub(c, a.store_id).configChanged(await toCtx(c.env, rec, true));
    return rec;
  }

  const unique = (e: unknown) => /UNIQUE|constraint/i.test(String(e));

  // ---------- 登入 ----------
  r.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    if (!email || !password || email.length > 200 || password.length > 200) return err(c, 401, "LOGIN_FAILED");
    const u = await c.env.DB.prepare(
      "SELECT id, store_id, display_name, password_hash, status, failed_attempts, locked_until, token_version FROM users WHERE email=? AND role='store_admin'",
    ).bind(email).first<any>();
    if (!u || u.status !== "active") return err(c, 401, "LOGIN_FAILED");
    if (u.locked_until && u.locked_until > now()) return err(c, 423, "LOCKED");
    if (!(await verifySecret(password, u.password_hash))) {
      const fails = u.failed_attempts + 1;
      const lock = fails >= LOCK_AFTER;
      const stmts = [
        c.env.DB.prepare("UPDATE users SET failed_attempts=?, locked_until=?, updated_at=? WHERE id=?").bind(lock ? 0 : fails, lock ? now() + LOCK_MS : u.locked_until, now(), u.id),
      ];
      if (lock) stmts.push(audit(c, u.store_id, u.id, "user.locked", u.id));
      await c.env.DB.batch(stmts);
      return err(c, 401, "LOGIN_FAILED");
    }
    const rec = await loadStore(c.env, u.store_id, now());
    if (!rec) return err(c, 404, "STORE_NOT_FOUND");
    const le = licenseError(rec, now());
    if (le) return err(c, 403, le);
    if (u.failed_attempts || u.locked_until) await c.env.DB.prepare("UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?").bind(u.id).run();
    c.header("set-cookie", refreshCookie(c.env, await issueRefresh(c.env, u, now()), REFRESH_TTL_S));
    return c.json(await issueAccess(c.env, u, now()));
  });

  r.post("/auth/refresh", async (c) => {
    const u = await verifyRefresh(c.env, readCookie(c.req.header("cookie"), REFRESH_COOKIE), now());
    if (!u) return err(c, 401, "REFRESH_INVALID");
    const rec = await loadStore(c.env, u.store_id, now());
    const le = rec ? licenseError(rec, now()) : "STORE_NOT_FOUND";
    if (le) return err(c, 403, le);
    return c.json(await issueAccess(c.env, u, now()));
  });

  r.post("/auth/logout", (c) => {
    c.header("set-cookie", refreshCookie(c.env, "", 0));
    return c.json({ ok: true });
  });

  // ---------- 之後全部需要店長 access token ＋ 門店開通（06 §2：停用／到期 → 403）----------
  r.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/store/auth/")) return next();
    const a = await verifyAdminAccess(c.env, bearer(c.req.header("authorization")), now());
    if (!a) return err(c, 401, "TOKEN_INVALID");
    const rec = await deps.storeOr(c, a.store_id);
    if (rec instanceof Response) return rec;
    c.set("admin", a);
    c.set("rec", rec);
    return next();
  });

  r.get("/me", async (c) => {
    const a = c.get("admin");
    const row = await c.env.DB.prepare("SELECT * FROM stores WHERE id=?").bind(a.store_id).first<any>();
    const rec = c.get("rec");
    return c.json({
      user: { id: a.sub, displayName: a.name },
      store: { ...rec.store, status: row.status, expiresAt: row.expires_at },
      limits: { maxDevices: row.max_devices, maxStaff: row.max_staff, adQuotaBytes: row.ad_quota_bytes },
    });
  });

  // ---------- 服務類別 ----------
  const svcOut = (x: any) => ({ id: x.id, name: x.name, prefix: x.prefix, sortOrder: x.sort_order, enabled: !!x.enabled, dailyLimit: x.daily_limit });
  function svcInput(b: any) {
    if (!isStr(b?.name, 1, 20) || typeof b?.prefix !== "string" || !PREFIX.test(b.prefix)) return null;
    const sortOrder = b.sortOrder == null ? 0 : b.sortOrder;
    const dailyLimit = b.dailyLimit == null || b.dailyLimit === "" ? null : b.dailyLimit;
    if (!isInt(sortOrder, 0, 999) || (dailyLimit !== null && !isInt(dailyLimit, 1, 9999))) return null;
    return { name: b.name.trim(), prefix: b.prefix, sortOrder, dailyLimit, enabled: b.enabled === false ? 0 : 1 };
  }

  r.get("/services", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM services WHERE store_id=? ORDER BY sort_order, prefix").bind(c.get("admin").store_id).all();
    return c.json({ services: rows.results.map(svcOut) });
  });
  r.post("/services", async (c) => {
    const v = svcInput(await c.req.json().catch(() => null));
    if (!v) return err(c, 422, "INVALID");
    const id = ulid(now());
    try {
      await change(c, [c.env.DB.prepare("INSERT INTO services(id,store_id,name,prefix,sort_order,enabled,daily_limit,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, c.get("admin").store_id, v.name, v.prefix, v.sortOrder, v.enabled, v.dailyLimit, now())], "service.create", id, { prefix: v.prefix });
    } catch (e) {
      if (unique(e)) return err(c, 409, "PREFIX_TAKEN");
      throw e;
    }
    return c.json({ service: svcOut({ id, ...v, sort_order: v.sortOrder, daily_limit: v.dailyLimit }) });
  });
  r.put("/services/:id", async (c) => {
    const v = svcInput(await c.req.json().catch(() => null));
    if (!v) return err(c, 422, "INVALID");
    const id = c.req.param("id");
    const sid = c.get("admin").store_id;
    if (!(await c.env.DB.prepare("SELECT 1 FROM services WHERE id=? AND store_id=?").bind(id, sid).first())) return err(c, 404, "NOT_FOUND");
    try {
      await change(c, [c.env.DB.prepare("UPDATE services SET name=?, prefix=?, sort_order=?, enabled=?, daily_limit=? WHERE id=? AND store_id=?").bind(v.name, v.prefix, v.sortOrder, v.enabled, v.dailyLimit, id, sid)], "service.update", id, { prefix: v.prefix, enabled: !!v.enabled });
    } catch (e) {
      if (unique(e)) return err(c, 409, "PREFIX_TAKEN");
      throw e;
    }
    return c.json({ ok: true });
  });
  r.delete("/services/:id", async (c) => {
    const id = c.req.param("id");
    const sid = c.get("admin").store_id;
    if (!(await c.env.DB.prepare("SELECT 1 FROM services WHERE id=? AND store_id=?").bind(id, sid).first())) return err(c, 404, "NOT_FOUND");
    const ctrs = await c.env.DB.prepare("SELECT id, service_ids FROM counters WHERE store_id=?").bind(sid).all<{ id: string; service_ids: string }>();
    const stmts = [c.env.DB.prepare("DELETE FROM services WHERE id=? AND store_id=?").bind(id, sid)];
    for (const ct of ctrs.results) {
      const ids: string[] = JSON.parse(ct.service_ids || "[]");
      if (ids.includes(id)) stmts.push(c.env.DB.prepare("UPDATE counters SET service_ids=? WHERE id=?").bind(JSON.stringify(ids.filter((x) => x !== id)), ct.id));
    }
    await change(c, stmts, "service.delete", id);
    return c.json({ ok: true });
  });

  // ---------- 櫃台 ----------
  const ctrOut = (x: any) => ({ id: x.id, name: x.name, number: x.number, serviceIds: JSON.parse(x.service_ids || "[]"), enabled: !!x.enabled });
  async function ctrInput(c: C, b: any) {
    if (!isStr(b?.name, 1, 20) || !isInt(b?.number, 1, 99) || !Array.isArray(b?.serviceIds) || b.serviceIds.length > 50) return null;
    const mine = new Set(
      (await c.env.DB.prepare("SELECT id FROM services WHERE store_id=?").bind(c.get("admin").store_id).all<{ id: string }>()).results.map((x) => x.id),
    );
    if (!b.serviceIds.every((x: unknown) => typeof x === "string" && mine.has(x))) return null;
    return { name: b.name.trim(), number: b.number as number, serviceIds: JSON.stringify(b.serviceIds), enabled: b.enabled === false ? 0 : 1 };
  }
  r.get("/counters", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM counters WHERE store_id=? ORDER BY number").bind(c.get("admin").store_id).all();
    return c.json({ counters: rows.results.map(ctrOut) });
  });
  r.post("/counters", async (c) => {
    const v = await ctrInput(c, await c.req.json().catch(() => null));
    if (!v) return err(c, 422, "INVALID");
    const id = ulid(now());
    try {
      await change(c, [c.env.DB.prepare("INSERT INTO counters(id,store_id,name,number,service_ids,enabled,created_at) VALUES(?,?,?,?,?,?,?)").bind(id, c.get("admin").store_id, v.name, v.number, v.serviceIds, v.enabled, now())], "counter.create", id, { number: v.number });
    } catch (e) {
      if (unique(e)) return err(c, 409, "NUMBER_TAKEN");
      throw e;
    }
    return c.json({ counter: ctrOut({ id, ...v, service_ids: v.serviceIds }) });
  });
  r.put("/counters/:id", async (c) => {
    const v = await ctrInput(c, await c.req.json().catch(() => null));
    if (!v) return err(c, 422, "INVALID");
    const id = c.req.param("id");
    const sid = c.get("admin").store_id;
    if (!(await c.env.DB.prepare("SELECT 1 FROM counters WHERE id=? AND store_id=?").bind(id, sid).first())) return err(c, 404, "NOT_FOUND");
    try {
      await change(c, [c.env.DB.prepare("UPDATE counters SET name=?, number=?, service_ids=?, enabled=? WHERE id=? AND store_id=?").bind(v.name, v.number, v.serviceIds, v.enabled, id, sid)], "counter.update", id, { number: v.number });
    } catch (e) {
      if (unique(e)) return err(c, 409, "NUMBER_TAKEN");
      throw e;
    }
    return c.json({ ok: true });
  });
  r.delete("/counters/:id", async (c) => {
    const id = c.req.param("id");
    const sid = c.get("admin").store_id;
    if (!(await c.env.DB.prepare("SELECT 1 FROM counters WHERE id=? AND store_id=?").bind(id, sid).first())) return err(c, 404, "NOT_FOUND");
    await change(c, [c.env.DB.prepare("DELETE FROM counters WHERE id=? AND store_id=?").bind(id, sid)], "counter.delete", id);
    return c.json({ ok: true });
  });

  // ---------- 人員帳號與 PIN ----------
  r.get("/staff", async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, display_name, status, locked_until, created_at FROM users WHERE store_id=? AND role='staff' ORDER BY created_at").bind(c.get("admin").store_id).all<any>();
    return c.json({
      staff: rows.results.map((u) => ({ id: u.id, displayName: u.display_name, status: u.status, locked: !!u.locked_until && u.locked_until > now() })),
      maxStaff: c.get("rec").maxStaff,
    });
  });
  r.post("/staff", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!isStr(b?.displayName, 1, 20)) return err(c, 422, "INVALID");
    const a = c.get("admin");
    const n = (await c.env.DB.prepare("SELECT count(*) AS n FROM users WHERE store_id=? AND role='staff' AND status='active'").bind(a.store_id).first<{ n: number }>())!.n;
    if (n >= c.get("rec").maxStaff) return err(c, 409, "STAFF_LIMIT", { max: c.get("rec").maxStaff });
    const id = ulid(now());
    const pin = randomPin();
    await change(
      c,
      [c.env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,pin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id, "staff", a.store_id, b.displayName.trim(), await hashSecret(pin), now(), now())],
      "user.create",
      id,
    );
    return c.json({ staff: { id, displayName: b.displayName.trim(), status: "active", locked: false }, pin });
  });

  async function staffRow(c: C) {
    return c.env.DB.prepare("SELECT id, status FROM users WHERE id=? AND store_id=? AND role='staff'").bind(c.req.param("id"), c.get("admin").store_id).first<any>();
  }
  async function revokeStaff(c: C, id: string) {
    invalidateStaff(id);
    await deps.stub(c, c.get("admin").store_id).disconnect({ staffId: id });
  }
  r.post("/staff/:id/reset-pin", async (c) => {
    const u = await staffRow(c);
    if (!u) return err(c, 404, "NOT_FOUND");
    const pin = randomPin();
    await change(c, [c.env.DB.prepare("UPDATE users SET pin_hash=?, token_version=token_version+1, failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?").bind(await hashSecret(pin), now(), u.id)], "user.reset_pin", u.id);
    await revokeStaff(c, u.id);
    return c.json({ pin });
  });
  r.post("/staff/:id/disable", async (c) => {
    const u = await staffRow(c);
    if (!u) return err(c, 404, "NOT_FOUND");
    await change(c, [c.env.DB.prepare("UPDATE users SET status='disabled', token_version=token_version+1, updated_at=? WHERE id=?").bind(now(), u.id)], "user.disable", u.id);
    await revokeStaff(c, u.id);
    return c.json({ ok: true });
  });
  r.post("/staff/:id/enable", async (c) => {
    const u = await staffRow(c);
    if (!u) return err(c, 404, "NOT_FOUND");
    if (u.status !== "active") {
      const a = c.get("admin");
      const n = (await c.env.DB.prepare("SELECT count(*) AS n FROM users WHERE store_id=? AND role='staff' AND status='active'").bind(a.store_id).first<{ n: number }>())!.n;
      if (n >= c.get("rec").maxStaff) return err(c, 409, "STAFF_LIMIT", { max: c.get("rec").maxStaff });
    }
    await change(c, [c.env.DB.prepare("UPDATE users SET status='active', updated_at=? WHERE id=?").bind(now(), u.id)], "user.enable", u.id);
    return c.json({ ok: true });
  });

  // ---------- 營業時間 ----------
  r.put("/hours", async (c) => {
    const b = await c.req.json().catch(() => null);
    const hours = b?.businessHours;
    if (!Array.isArray(hours) || hours.length > 21) return err(c, 422, "INVALID");
    for (const h of hours) {
      if (!isInt(h?.dow, 0, 6) || !HHMM.test(h?.open ?? "") || !HHMM.test(h?.close ?? "") || h.open >= h.close) return err(c, 422, "INVALID");
    }
    const clean = hours.map((h: any) => ({ dow: h.dow, open: h.open, close: h.close }));
    await change(c, [c.env.DB.prepare("UPDATE stores SET business_hours=? WHERE id=?").bind(JSON.stringify(clean), c.get("admin").store_id)], "store.hours", null);
    return c.json({ ok: true, businessHours: clean });
  });

  // ---------- 叫號語音（3.3）----------
  r.put("/settings/voice", async (c) => {
    const b = await c.req.json().catch(() => null);
    const raw = b?.voiceSettings;
    if (!raw || typeof raw !== "object") return err(c, 422, "INVALID");
    const cap = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x) => typeof x === "string" && x.length <= 40).slice(0, 300) : []);
    const vs = normalizeVoiceSettings({ ...raw, enabledPacks: cap(raw.enabledPacks), disabledLines: cap(raw.disabledLines), muteRanges: Array.isArray(raw.muteRanges) ? raw.muteRanges.slice(0, 10) : [] });
    await change(c, [c.env.DB.prepare("UPDATE stores SET voice_settings=? WHERE id=?").bind(JSON.stringify(vs), c.get("admin").store_id)], "store.voice", null, { mode: vs.mode });
    return c.json({ ok: true, voiceSettings: vs });
  });

  // ---------- 一般設定：遮罩姓名、前面剩幾位提醒 ----------
  r.put("/settings/general", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (typeof b?.showMaskedName !== "boolean" || !isInt(b?.notifyAhead, 1, 5)) return err(c, 422, "INVALID");
    const features = { ...c.get("rec").store.features, showMaskedName: b.showMaskedName };
    await change(
      c,
      [c.env.DB.prepare("UPDATE stores SET features=?, notify_ahead=? WHERE id=?").bind(JSON.stringify(features), b.notifyAhead, c.get("admin").store_id)],
      "store.settings",
      null,
      { showMaskedName: b.showMaskedName, notifyAhead: b.notifyAhead },
    );
    return c.json({ ok: true });
  });

  // ---------- 重設 QR 金鑰（ADR-012）：已流出的網址立即失效 ----------
  r.post("/qr/rotate", async (c) => {
    const rec = await change(c, [c.env.DB.prepare("UPDATE stores SET qr_key_version=qr_key_version+1 WHERE id=?").bind(c.get("admin").store_id)], "qr.rotate", null);
    return c.json({ ok: true, keyVersion: rec.qrKeyVersion });
  });

  registerDeviceRoutes(r, { deps, change });
  registerAdRoutes(r, { deps, change });

  return r;
}

export { invalidateUserCache };

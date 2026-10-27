import { Hono } from "hono";
import { cors } from "hono/cors";
import { b64urlDecode, normalizePhone, ulid, validateName, verifyQrToken, deriveStoreKey } from "@qcs/shared";
import type { Env } from "./env";
import { encodeHeader } from "./do/store-queue";
import { signJwt, verifyJwt } from "./lib/jwt";
import { verifySecret } from "./lib/password";
import { bearer, protocolToken, verifyDeviceToken, verifyStaffToken, verifyTicketToken } from "./lib/auth";
import { licenseError, loadStore, refreshStore, storeIdByCode, toCtx, type StoreRecord } from "./lib/store-ctx";
import { verifyAdminAccess } from "./lib/admin-auth";
import { err, type AppEnv, type C } from "./routes/common";
import { storeAdminRoutes } from "./routes/store-admin";
import { pairingRoutes } from "./routes/pairing";
import { serveLocalMedia } from "./routes/ads";

export const VERSION = "0.1.0";
const SESSION_TTL_S = 10 * 60;
const TICKET_TTL_S = 24 * 3600;
const STAFF_TTL_S = 12 * 3600;
const XFER_TTL_MS = 10 * 60_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;


export interface AppDeps {
  now?: () => number;
}

export function createApp(deps: AppDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const app = new Hono<AppEnv>();
  const stub = (c: C, storeId: string) => c.env.STORE_QUEUE.get(c.env.STORE_QUEUE.idFromName(storeId));

  // production 不得帶本機繞過旗標（11 §1）
  app.use("*", async (c, next) => {
    if (c.env.ENV === "production" && c.env.DEV_BYPASS_ACCESS) return c.json({ code: "MISCONFIGURED" }, 500);
    await next();
  });

  app.use(
    "/api/*",
    cors({
      origin: (o, c) => ((c.env as Env).APP_ORIGINS ?? "").split(",").includes(o) ? o : null,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true, // 門店後台 refresh cookie（只送 /api/store/auth，SameSite=Strict）
      maxAge: 86400,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, env: c.env.ENV }));
  app.get("/media/*", serveLocalMedia);

  /** 門店開啟推播且已設定 VAPID 才給公鑰；前端拿不到就不請求通知權限（07 §2）。 */
  const pushInfo = (c: C, rec: StoreRecord) =>
    rec.store.features?.push !== false && c.env.VAPID_PUBLIC_KEY ? { publicKey: c.env.VAPID_PUBLIC_KEY } : null;

  async function storeOr(c: C, storeId: string): Promise<StoreRecord | Response> {
    const rec = await loadStore(c.env, storeId, now());
    if (!rec) return err(c, 404, "STORE_NOT_FOUND");
    const le = licenseError(rec, now());
    if (le) return err(c, 403, le);
    return rec;
  }

  // ---------- 顧客：掃碼 → 取號 session（ADR-012）----------
  app.get("/api/s/:code/session", async (c) => {
    const id = await storeIdByCode(c.env, c.req.param("code"), now());
    if (!id) return err(c, 404, "STORE_NOT_FOUND");
    const rec = await storeOr(c, id);
    if (rec instanceof Response) return rec;
    const w = Number(c.req.query("w"));
    const k = c.req.query("k") ?? "";
    const key = await deriveStoreKey(c.env.QR_ROOT_SECRET, id, rec.qrKeyVersion);
    const v = await verifyQrToken(key, id, w, k, now());
    if (v === "expired") return err(c, 401, "QR_EXPIRED");
    if (v !== "ok") return err(c, 401, "QR_INVALID");
    const jti = ulid(now());
    const exp = Math.floor(now() / 1000) + SESSION_TTL_S;
    const sessionToken = await signJwt(c.env.JWT_SECRET, { sub: jti, jti, role: "take", store_id: id, exp });
    const { waiting } = await stub(c, id).summary(await toCtx(c.env, rec, false));
    return c.json({
      sessionToken,
      expiresAt: exp * 1000,
      store: { id, code: rec.store.code, name: rec.store.name, logoUrl: rec.store.logoUrl },
      services: rec.store.services.map((s) => ({ id: s.id, name: s.name, prefix: s.prefix, waiting: waiting[s.id] ?? 0 })),
      push: pushInfo(c, rec),
    });
  });

  app.post("/api/s/:code/tickets", async (c) => {
    const id = await storeIdByCode(c.env, c.req.param("code"), now());
    if (!id) return err(c, 404, "STORE_NOT_FOUND");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return err(c, 400, "BAD_JSON");
    if (body.consent !== true) return err(c, 422, "CONSENT_REQUIRED");
    const name = validateName(String(body.name ?? ""));
    if (!name) return err(c, 422, "NAME_INVALID");
    const phone = normalizePhone(String(body.phone ?? ""));
    if (!phone) return err(c, 422, "PHONE_INVALID");
    const sess = await verifyJwt(c.env.JWT_SECRET, String(body.session ?? ""), now());
    if (!sess || sess.role !== "take" || sess.store_id !== id || !sess.jti) return err(c, 401, "SESSION_INVALID");
    const rec = await storeOr(c, id);
    if (rec instanceof Response) return rec;
    const r = await stub(c, id).takeTicket(await toCtx(c.env, rec, false), {
      jti: sess.jti,
      serviceId: String(body.serviceId ?? ""),
      name,
      phone,
    });
    if (!r.ok) return err(c, r.status, r.code);
    const ticketToken = await signJwt(c.env.JWT_SECRET, {
      sub: r.ticket.id,
      role: "customer",
      store_id: id,
      exp: Math.floor(now() / 1000) + TICKET_TTL_S,
    });
    return c.json({ ticket: r.ticket, ticketToken, existing: r.existing, store: { id, code: rec.store.code, name: rec.store.name } });
  });

  app.get("/api/tickets/me", async (c) => {
    const t = await verifyTicketToken(c.env, bearer(c.req.header("authorization")), now());
    if (!t) return err(c, 401, "TOKEN_INVALID");
    const rec = await loadStore(c.env, t.store_id, now());
    if (!rec) return err(c, 404, "STORE_NOT_FOUND");
    const ticket = await stub(c, t.store_id).ticketView(await toCtx(c.env, rec, false), t.sub);
    if (!ticket) return err(c, 404, "TICKET_NOT_FOUND");
    return c.json({ ticket, store: { id: rec.store.id, code: rec.store.code, name: rec.store.name, logoUrl: rec.store.logoUrl }, push: pushInfo(c, rec) });
  });

  app.post("/api/tickets/:id/cancel", async (c) => {
    const t = await verifyTicketToken(c.env, bearer(c.req.header("authorization")), now());
    if (!t) return err(c, 401, "TOKEN_INVALID");
    if (t.sub !== c.req.param("id")) return err(c, 403, "FORBIDDEN");
    const rec = await storeOr(c, t.store_id);
    if (rec instanceof Response) return rec;
    const r = await stub(c, t.store_id).cancelTicket(await toCtx(c.env, rec, false), t.sub);
    return r.ok ? c.json({ ok: true }) : err(c, 409, r.code ?? "BAD_STATE");
  });

  // 推播訂閱（07 §2、§6）：一號一筆，號碼結束由 q-history 刪除、孤兒 24 小時由 Cron 清
  app.post("/api/tickets/:id/push", async (c) => {
    const t = await verifyTicketToken(c.env, bearer(c.req.header("authorization")), now());
    if (!t) return err(c, 401, "TOKEN_INVALID");
    if (t.sub !== c.req.param("id")) return err(c, 403, "FORBIDDEN");
    const body = await c.req.json().catch(() => null);
    const sub = parseSubscription(body, c.env.ENV === "local");
    if (!sub) return err(c, 422, "SUBSCRIPTION_INVALID");
    const rec = await storeOr(c, t.store_id);
    if (rec instanceof Response) return rec;
    if (!pushInfo(c, rec)) return err(c, 403, "PUSH_DISABLED");
    const r = await stub(c, t.store_id).enablePush(await toCtx(c.env, rec, false), t.sub);
    if (!r.ok) return err(c, 409, r.code ?? "BAD_STATE");
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions(ticket_id,store_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(ticket_id) DO UPDATE SET endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth`,
    ).bind(t.sub, t.store_id, sub.endpoint, sub.p256dh, sub.auth, now()).run();
    return c.json({ ok: true });
  });

  // iOS 加入主畫面轉交碼（07 §3、ADR-034）：6 位數、10 分鐘、單次使用；D1 只存 ticket_id
  app.post("/api/tickets/:id/transfer", async (c) => {
    const t = await verifyTicketToken(c.env, bearer(c.req.header("authorization")), now());
    if (!t) return err(c, 401, "TOKEN_INVALID");
    if (t.sub !== c.req.param("id")) return err(c, 403, "FORBIDDEN");
    const exp = now() + XFER_TTL_MS;
    for (let i = 0; i < 5; i++) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      const r = await c.env.DB.prepare(
        "INSERT INTO transfer_codes(code,store_id,ticket_id,expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET store_id=excluded.store_id, ticket_id=excluded.ticket_id, expires_at=excluded.expires_at, created_at=excluded.created_at WHERE transfer_codes.expires_at < ?",
      ).bind(code, t.store_id, t.sub, exp, now(), now()).run();
      if (r.meta.changes) return c.json({ code, expiresAt: exp });
    }
    return err(c, 503, "TRY_AGAIN");
  });

  app.post("/api/transfer/redeem", async (c) => {
    const body = await c.req.json().catch(() => null);
    const code = String(body?.code ?? "");
    if (!/^\d{6}$/.test(code)) return err(c, 422, "CODE_FORMAT");
    const row = await c.env.DB.prepare("DELETE FROM transfer_codes WHERE code=? RETURNING store_id, ticket_id, expires_at").bind(code).first<{
      store_id: string;
      ticket_id: string;
      expires_at: number;
    }>();
    if (!row || row.expires_at < now()) return err(c, 404, "CODE_NOT_FOUND");
    const rec = await storeOr(c, row.store_id);
    if (rec instanceof Response) return rec;
    const ticket = await stub(c, row.store_id).ticketView(await toCtx(c.env, rec, false), row.ticket_id);
    if (!ticket || !["waiting", "called", "serving", "skipped"].includes(ticket.status)) return err(c, 409, "TICKET_ENDED");
    const ticketToken = await signJwt(c.env.JWT_SECRET, { sub: row.ticket_id, role: "customer", store_id: row.store_id, exp: Math.floor(now() / 1000) + TICKET_TTL_S });
    return c.json({ ticketToken, ticket, store: { id: rec.store.id, code: rec.store.code, name: rec.store.name, logoUrl: rec.store.logoUrl }, push: pushInfo(c, rec) });
  });

  // ---------- 人員（ADR-004：裝置綁店＋PIN）----------
  app.get("/api/staff/device", async (c) => {
    const d = await verifyDeviceToken(c.env, bearer(c.req.header("authorization")), "staff_device", now());
    if (!d) return err(c, 401, "DEVICE_INVALID");
    const rec = await storeOr(c, d.store_id);
    if (rec instanceof Response) return rec;
    const staff = await c.env.DB.prepare(
      "SELECT id, display_name FROM users WHERE store_id=? AND role='staff' AND status='active' ORDER BY display_name",
    ).bind(d.store_id).all<{ id: string; display_name: string }>();
    return c.json({
      store: { id: rec.store.id, name: rec.store.name, logoUrl: rec.store.logoUrl },
      staff: staff.results.map((u) => ({ id: u.id, displayName: u.display_name })),
      counters: rec.store.counters,
      services: rec.store.services,
    });
  });

  // 人員端斷線後確認自己的登入是否仍有效（被停用／重設 PIN／手機解除時回登入畫面）
  app.get("/api/staff/me", async (c) => {
    const s = await verifyStaffToken(c.env, bearer(c.req.header("authorization")), now());
    return s ? c.json({ ok: true, userId: s.sub }) : err(c, 401, "TOKEN_INVALID");
  });

  app.post("/api/staff/login", async (c) => {
    const d = await verifyDeviceToken(c.env, bearer(c.req.header("authorization")), "staff_device", now());
    if (!d) return err(c, 401, "DEVICE_INVALID");
    const body = await c.req.json().catch(() => null);
    const pin = String(body?.pin ?? "");
    if (!/^\d{6}$/.test(pin)) return err(c, 422, "PIN_FORMAT");
    const u = await c.env.DB.prepare(
      "SELECT id, display_name, pin_hash, status, failed_attempts, locked_until, token_version FROM users WHERE id=? AND store_id=? AND role='staff'",
    ).bind(String(body?.userId ?? ""), d.store_id).first<any>();
    if (!u || u.status !== "active") return err(c, 401, "LOGIN_FAILED");
    if (u.locked_until && u.locked_until > now()) return err(c, 423, "LOCKED");
    if (!(await verifySecret(pin, u.pin_hash))) {
      const fails = u.failed_attempts + 1;
      const lock = fails >= LOCK_AFTER;
      await c.env.DB.prepare("UPDATE users SET failed_attempts=?, locked_until=?, updated_at=? WHERE id=?")
        .bind(lock ? 0 : fails, lock ? now() + LOCK_MS : u.locked_until, now(), u.id)
        .run();
      if (lock) {
        await c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target) VALUES(?,?,?,?,?,?,?)")
          .bind(ulid(now()), now(), "device", d.sub, d.store_id, "user.locked", u.id)
          .run();
      }
      return err(c, 401, "LOGIN_FAILED");
    }
    if (u.failed_attempts || u.locked_until) {
      await c.env.DB.prepare("UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?").bind(u.id).run();
    }
    const exp = Math.floor(now() / 1000) + STAFF_TTL_S;
    const token = await signJwt(c.env.JWT_SECRET, {
      sub: u.id,
      role: "staff",
      store_id: d.store_id,
      tv: u.token_version,
      did: d.sub,
      dtv: d.tv ?? 1,
      name: u.display_name,
      exp,
    });
    return c.json({ token, expiresAt: exp * 1000, user: { id: u.id, displayName: u.display_name } });
  });

  // ---------- 面板 ----------
  app.get("/api/display/ads/manifest", async (c) => {
    const d = await verifyDeviceToken(c.env, bearer(c.req.header("authorization")), "display", now());
    if (!d) return err(c, 401, "DEVICE_INVALID");
    const pl = await c.env.DB.prepare("SELECT id, version FROM ad_playlists WHERE owner_type='store' AND owner_id=?")
      .bind(d.store_id)
      .first<{ id: string; version: number }>();
    if (!pl) return c.json({ version: 0, items: [] });
    const items = await c.env.DB.prepare(
      `SELECT i.asset_id, i.duration_ms, i.active_from, i.active_to, i.active_dows, i.start_date, i.end_date, a.kind, a.r2_key, a.mime
       FROM ad_playlist_items i JOIN ad_assets a ON a.id = i.asset_id
       WHERE i.playlist_id=? AND i.enabled=1 AND a.status='ready' ORDER BY i.sort_order`,
    ).bind(pl.id).all<any>();
    return c.json({
      version: pl.version,
      items: items.results.map((r) => ({
        assetId: r.asset_id,
        url: `${c.env.MEDIA_BASE}/${r.r2_key}`,
        kind: r.kind,
        mime: r.mime,
        durationMs: r.duration_ms,
        activeFrom: r.active_from,
        activeTo: r.active_to,
        dows: JSON.parse(r.active_dows ?? "[0,1,2,3,4,5,6]"),
        startDate: r.start_date,
        endDate: r.end_date,
      })),
    });
  });

  // ---------- WebSocket：驗身分＋開通後轉交 DO（04 §1）----------
  app.get("/ws/store/:storeId", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") return err(c, 426, "UPGRADE_REQUIRED");
    const storeId = c.req.param("storeId");
    const role = c.req.query("role");
    const token = protocolToken(c.req.header("Sec-WebSocket-Protocol") ?? null);
    const t = now();
    let auth: Record<string, unknown> | null = null;
    if (role === "display") {
      const d = await verifyDeviceToken(c.env, token, "display", t);
      if (d) auth = { role, deviceId: d.sub, store: d.store_id };
    } else if (role === "staff") {
      const s = await verifyStaffToken(c.env, token, t);
      if (s) auth = { role, staffId: s.sub, deviceId: s.did, store: s.store_id };
      else {
        // 門店後台「即時隊列」：店長以 access token 連線，權限同人員（05-apps §4）
        const a = await verifyAdminAccess(c.env, token, t);
        if (a) auth = { role, staffId: a.sub, store: a.store_id };
      }
    } else if (role === "customer") {
      const s = await verifyTicketToken(c.env, token, t);
      if (s) auth = { role, ticketId: s.sub, store: s.store_id };
    }
    if (!auth) return err(c, 401, "TOKEN_INVALID");
    if (auth.store !== storeId) return err(c, 403, "FORBIDDEN");
    delete auth.store;
    const rec = await storeOr(c, storeId);
    if (rec instanceof Response) return rec;
    const lastSeq = c.req.query("lastSeq");
    const req = new Request(`https://do/ws${lastSeq ? `?lastSeq=${encodeURIComponent(lastSeq)}` : ""}`, {
      headers: {
        Upgrade: "websocket",
        "x-qcs-ctx": encodeHeader(await toCtx(c.env, rec, role === "display")),
        "x-qcs-auth": encodeHeader(auth),
        "x-qcs-proto": "qcs.v1",
      },
    });
    return stub(c, storeId).fetch(req);
  });

  app.route("/api/store", storeAdminRoutes({ now, storeOr, stub }));
  app.route("/api", pairingRoutes({ now, storeOr, stub }));

  // ---------- 平台管理（Cloudflare Access；M1 僅本機繞過，Access JWT 驗證在 M4 4.1）----------
  app.use("/api/admin/*", async (c, next) => {
    if (c.env.ENV === "local" && c.env.DEV_BYPASS_ACCESS === "1") return next();
    return err(c, 401, "ACCESS_REQUIRED");
  });

  async function setStatus(c: C, status: "active" | "suspended") {
    const id = c.req.param("id")!;
    const r = await c.env.DB.prepare("UPDATE stores SET status=?, updated_at=MAX(updated_at+1, ?) WHERE id=?").bind(status, now(), id).run();
    if (!r.meta.changes) return err(c, 404, "STORE_NOT_FOUND");
    const rec = (await refreshStore(c.env, id))!;
    await c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action) VALUES(?,?,?,?,?,?)")
      .bind(ulid(now()), now(), "platform_admin", "dev", id, status === "active" ? "store.resume" : "store.suspend")
      .run();
    if (status === "suspended") await stub(c, id).suspend("suspended", rec.license);
    else await stub(c, id).resume(await toCtx(c.env, rec, false));
    return c.json({ ok: true, status });
  }
  app.post("/api/admin/stores/:id/suspend", (c) => setStatus(c, "suspended"));
  app.post("/api/admin/stores/:id/resume", (c) => setStatus(c, "active"));

  app.notFound((c) => err(c, 404, "NOT_FOUND"));
  app.onError((e, c) => {
    console.error("unhandled", e);
    return err(c, 500, "INTERNAL");
  });
  return app;
}

export const app = createApp();

/** PushSubscription.toJSON() 格式驗證。endpoint 只收 https（本機測試允許 http://127.0.0.1／localhost 假端點）。 */
export function parseSubscription(body: any, allowLocalHttp: boolean): { endpoint: string; p256dh: string; auth: string } | null {
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || endpoint.length > 1024) return null;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  const localHttp = allowLocalHttp && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !localHttp) return null;
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
  if (!b64.test(p256dh) || !b64.test(auth)) return null;
  try {
    if (b64urlDecode(p256dh.replace(/=+$/, "")).length !== 65 || b64urlDecode(auth.replace(/=+$/, "")).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh: p256dh.replace(/=+$/, ""), auth: auth.replace(/=+$/, "") };
}


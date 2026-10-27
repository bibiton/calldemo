/**
 * 裝置配對（06-auth §3）：面板／人員手機顯示 6 位配對碼 → 店長在門店後台輸入 → 裝置輪詢（每 3 秒，最多 10 分鐘）領 token。
 * 面板端全程不需輸入（遙控器即可，ADR-027）。輪詢是全系統唯一允許的輪詢，每台裝置一生只發生一次。
 */
import { Hono } from "hono";
import { toHex, ulid } from "@qcs/shared";
import { signJwt } from "../lib/jwt";
import { invalidateDevice } from "../lib/auth";
import { err, isStr, type AppEnv, type C, type Deps } from "./common";

const PAIR_TTL_MS = 10 * 60_000;
const DEVICE_TTL_S = 365 * 24 * 3600;
type Kind = "display" | "staff_device";

const sha256 = async (s: string) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

/** 裝置端（未登入）：/api/display/pair/*、/api/staff/pair/* */
export function pairingRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const kindOf = (seg: string): Kind | null => (seg === "display" ? "display" : seg === "staff" ? "staff_device" : null);

  r.post("/:seg/pair/start", async (c) => {
    const kind = kindOf(c.req.param("seg"));
    if (!kind) return err(c, 404, "NOT_FOUND");
    const secret = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = deps.now();
    for (let i = 0; i < 5; i++) {
      const code = randomCode();
      const res = await c.env.DB.prepare(
        `INSERT INTO pairings(code,kind,poll_hash,store_id,device_id,expires_at,created_at) VALUES(?,?,?,NULL,NULL,?,?)
         ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, poll_hash=excluded.poll_hash, store_id=NULL, device_id=NULL,
           expires_at=excluded.expires_at, created_at=excluded.created_at WHERE pairings.expires_at < ?`,
      ).bind(code, kind, await sha256(secret), now + PAIR_TTL_MS, now, now).run();
      if (res.meta.changes) return c.json({ code, pollSecret: secret, expiresAt: now + PAIR_TTL_MS });
    }
    return err(c, 503, "TRY_AGAIN");
  });

  r.get("/:seg/pair/status", async (c) => {
    const kind = kindOf(c.req.param("seg"));
    const code = c.req.query("code") ?? "";
    const secret = c.req.query("secret") ?? "";
    if (!kind || !/^\d{6}$/.test(code) || !secret) return err(c, 404, "NOT_FOUND");
    const p = await c.env.DB.prepare("SELECT * FROM pairings WHERE code=?").bind(code).first<any>();
    if (!p || p.kind !== kind || p.poll_hash !== (await sha256(secret)) || (p.expires_at < deps.now() && !p.device_id)) return err(c, 404, "NOT_FOUND");
    if (!p.device_id) return c.json({ status: "pending", expiresAt: p.expires_at });
    // 領 token：單次（刪掉配對列）
    const del = await c.env.DB.prepare("DELETE FROM pairings WHERE code=? AND device_id IS NOT NULL").bind(code).run();
    if (!del.meta.changes) return err(c, 404, "NOT_FOUND");
    const d = await c.env.DB.prepare("SELECT id, store_id, token_version, status FROM devices WHERE id=?").bind(p.device_id).first<any>();
    if (!d || d.status !== "active") return err(c, 404, "NOT_FOUND");
    const token = await signJwt(c.env.JWT_SECRET, { sub: d.id, role: kind, store_id: d.store_id, tv: d.token_version, exp: Math.floor(deps.now() / 1000) + DEVICE_TTL_S });
    return c.json({ status: "paired", token, storeId: d.store_id });
  });

  return r;
}

export interface AdminHelpers {
  deps: Deps;
  change: (c: C, stmts: D1PreparedStatement[], action: string, target: string | null, detail?: unknown) => Promise<unknown>;
}

/** 門店後台：裝置清單、輸入配對碼、解除配對（掛在 /api/store 的店長驗證之後）。 */
export function registerDeviceRoutes(r: Hono<AppEnv>, h: AdminHelpers): void {
  const { deps } = h;

  r.get("/devices", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id, kind, name, status, client_kind, audio_status, audio_status_at, last_seen_at, created_at FROM devices WHERE store_id=? AND status='active' ORDER BY kind, created_at",
    ).bind(c.get("admin").store_id).all<any>();
    return c.json({
      devices: rows.results.map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        status: d.status,
        client: d.client_kind,
        audio: d.audio_status,
        audioAt: d.audio_status_at,
        createdAt: d.created_at,
      })),
      maxDevices: c.get("rec").maxDevices,
    });
  });

  r.post("/devices/pair", async (c) => {
    const b = await c.req.json().catch(() => null);
    const code = String(b?.code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return err(c, 422, "CODE_FORMAT");
    const name = isStr(b?.name, 1, 20) ? b.name.trim() : null;
    const sid = c.get("admin").store_id;
    const p = await c.env.DB.prepare("SELECT * FROM pairings WHERE code=?").bind(code).first<any>();
    if (!p || p.expires_at < deps.now() || p.device_id) return err(c, 404, "CODE_NOT_FOUND");
    if (p.kind === "display") {
      const n = (await c.env.DB.prepare("SELECT count(*) AS n FROM devices WHERE store_id=? AND kind='display' AND status='active'").bind(sid).first<{ n: number }>())!.n;
      const max = c.get("rec").maxDevices;
      if (n >= max) return err(c, 409, "DEVICE_LIMIT", { max });
    }
    const id = ulid(deps.now());
    const dname = name ?? (p.kind === "display" ? "叫號面板" : "人員手機");
    await h.change(
      c,
      [
        c.env.DB.prepare("INSERT INTO devices(id,store_id,kind,name,status,token_version,last_seen_at,created_at) VALUES(?,?,?,?,'active',1,?,?)").bind(id, sid, p.kind, dname, deps.now(), deps.now()),
        c.env.DB.prepare("UPDATE pairings SET store_id=?, device_id=? WHERE code=? AND device_id IS NULL").bind(sid, id, code),
      ],
      "device.pair",
      id,
      { kind: p.kind },
    );
    return c.json({ device: { id, kind: p.kind, name: dname, status: "active" } });
  });

  r.post("/devices/:id/revoke", async (c) => {
    const sid = c.get("admin").store_id;
    const id = c.req.param("id");
    const d = await c.env.DB.prepare("SELECT id, kind FROM devices WHERE id=? AND store_id=? AND status='active'").bind(id, sid).first<any>();
    if (!d) return err(c, 404, "NOT_FOUND");
    await h.change(c, [c.env.DB.prepare("UPDATE devices SET status='revoked', token_version=token_version+1 WHERE id=?").bind(id)], "device.revoke", id, { kind: d.kind });
    invalidateDevice(id);
    await deps.stub(c, sid).disconnect({ deviceId: id });
    return c.json({ ok: true });
  });
}

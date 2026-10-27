/**
 * 廣告管理（05-apps §4、ADR-016／028）：前端先檢查格式／大小／解析度／長度 → 申請上傳（Worker 檢查容量）→
 * PUT 串流寫入 R2（同時算 SHA-256 驗證內容）→ ready、加入播放清單、版本 +1 → DO 廣播 ads.manifest。
 * R2 key 內容定址 ads/<store>/<sha256>.<ext>，不可變，可長期快取。
 */
import type { Hono } from "hono";
import { toHex, ulid } from "@qcs/shared";
import { err, HHMM, isInt, isStr, type AppEnv, type C } from "./common";
import type { AdminHelpers } from "./pairing";

export const AD_LIMITS = {
  image: { maxBytes: 5 * 1024 * 1024, mimes: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string> },
  video: { maxBytes: 50 * 1024 * 1024, maxMs: 120_000, mimes: { "video/mp4": "mp4" } as Record<string, string> },
};
export const DEFAULT_IMAGE_MS = 8_000;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

async function usedBytes(c: C, sid: string): Promise<number> {
  return (await c.env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM ad_assets WHERE owner_type='store' AND owner_id=? AND status='ready'").bind(sid).first<{ n: number }>())!.n;
}

async function playlist(c: C, sid: string): Promise<{ id: string; version: number }> {
  const p = await c.env.DB.prepare("SELECT id, version FROM ad_playlists WHERE owner_type='store' AND owner_id=?").bind(sid).first<{ id: string; version: number }>();
  if (p) return p;
  const id = ulid(Date.now());
  await c.env.DB.prepare("INSERT OR IGNORE INTO ad_playlists(id,owner_type,owner_id,version,accept_brand,updated_at) VALUES(?,'store',?,0,1,?)").bind(id, sid, Date.now()).run();
  return (await c.env.DB.prepare("SELECT id, version FROM ad_playlists WHERE owner_type='store' AND owner_id=?").bind(sid).first<{ id: string; version: number }>())!;
}

export function registerAdRoutes(r: Hono<AppEnv>, h: AdminHelpers): void {
  const { deps } = h;
  const now = () => deps.now();
  const audit = (c: C, action: string, target: string, detail: unknown) =>
    c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target,detail) VALUES(?,?,?,?,?,?,?,?)").bind(
      ulid(now()),
      now(),
      "store_admin",
      c.get("admin").sub,
      c.get("admin").store_id,
      action,
      target,
      JSON.stringify(detail),
    );

  /** 播放清單版本 +1（與變更同一個 batch）後通知面板。 */
  async function bump(c: C, stmts: D1PreparedStatement[]): Promise<number> {
    const sid = c.get("admin").store_id;
    const pl = await playlist(c, sid);
    await c.env.DB.batch([...stmts, c.env.DB.prepare("UPDATE ad_playlists SET version=version+1, updated_at=? WHERE id=?").bind(now(), pl.id)]);
    const v = pl.version + 1;
    await deps.stub(c, sid).adsChanged(v);
    return v;
  }

  r.get("/ads", async (c) => {
    const sid = c.get("admin").store_id;
    const pl = await playlist(c, sid);
    const rows = await c.env.DB.prepare(
      `SELECT i.id AS item_id, i.sort_order, i.duration_ms AS item_ms, i.active_from, i.active_to, i.active_dows, i.start_date, i.end_date, i.enabled,
              a.id AS asset_id, a.kind, a.mime, a.bytes, a.width, a.height, a.duration_ms AS asset_ms, a.r2_key, a.name, a.created_at
       FROM ad_playlist_items i JOIN ad_assets a ON a.id=i.asset_id
       WHERE i.playlist_id=? AND a.status='ready' ORDER BY i.sort_order, i.id`,
    ).bind(pl.id).all<any>();
    return c.json({
      version: pl.version,
      usedBytes: await usedBytes(c, sid),
      quotaBytes: c.get("rec").adQuotaBytes,
      items: rows.results.map((x) => ({
        itemId: x.item_id,
        assetId: x.asset_id,
        kind: x.kind,
        mime: x.mime,
        name: x.name,
        bytes: x.bytes,
        width: x.width,
        height: x.height,
        videoMs: x.asset_ms,
        imageMs: x.item_ms,
        enabled: !!x.enabled,
        activeFrom: x.active_from,
        activeTo: x.active_to,
        dows: JSON.parse(x.active_dows || "[0,1,2,3,4,5,6]"),
        startDate: x.start_date,
        endDate: x.end_date,
        url: `${c.env.MEDIA_BASE}/${x.r2_key}`,
        createdAt: x.created_at,
      })),
    });
  });

  r.post("/ads/uploads", async (c) => {
    const b = await c.req.json().catch(() => null);
    const kind = b?.kind === "video" ? "video" : b?.kind === "image" ? "image" : null;
    if (!kind) return err(c, 422, "KIND_INVALID");
    const lim = AD_LIMITS[kind];
    const ext = lim.mimes[String(b.mime)];
    if (!ext) return err(c, 422, "MIME_INVALID");
    if (!isInt(b.bytes, 1, lim.maxBytes)) return err(c, 422, "TOO_LARGE", { max: lim.maxBytes });
    if (kind === "video" && !isInt(b.durationMs, 1, AD_LIMITS.video.maxMs)) return err(c, 422, "TOO_LONG", { max: AD_LIMITS.video.maxMs });
    if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return err(c, 422, "SHA_INVALID");
    const w = isInt(b.width, 1, 10000) ? b.width : null;
    const hgt = isInt(b.height, 1, 10000) ? b.height : null;
    const name = isStr(b.name, 1, 80) ? b.name.trim() : null;
    const sid = c.get("admin").store_id;
    const used = await usedBytes(c, sid);
    const quota = c.get("rec").adQuotaBytes;
    if (used + b.bytes > quota) return err(c, 409, "QUOTA_EXCEEDED", { used, quota });
    const id = ulid(now());
    await c.env.DB.prepare(
      "INSERT INTO ad_assets(id,owner_type,owner_id,kind,r2_key,sha256,mime,bytes,width,height,duration_ms,status,created_by,created_at,name) VALUES(?,'store',?,?,?,?,?,?,?,?,?,'uploading',?,?,?)",
    ).bind(id, sid, kind, `ads/${sid}/${b.sha256}.${ext}`, b.sha256, b.mime, b.bytes, w, hgt, kind === "video" ? b.durationMs : null, c.get("admin").sub, now(), name).run();
    return c.json({ assetId: id, uploadUrl: `/api/store/ads/uploads/${id}` });
  });

  r.put("/ads/uploads/:id", async (c) => {
    const sid = c.get("admin").store_id;
    const a = await c.env.DB.prepare("SELECT * FROM ad_assets WHERE id=? AND owner_type='store' AND owner_id=? AND status='uploading'").bind(c.req.param("id"), sid).first<any>();
    if (!a) return err(c, 404, "NOT_FOUND");
    const len = Number(c.req.header("content-length"));
    const body = c.req.raw.body;
    if (!body || len !== a.bytes) {
      await c.env.DB.prepare("DELETE FROM ad_assets WHERE id=?").bind(a.id).run();
      return err(c, 422, "SIZE_MISMATCH");
    }
    // 串流：一路寫 R2、一路算 SHA-256（不把 50 MB 整個讀進記憶體）。workerd 不支援內部 TransformStream 之間 pipeTo，改手動讀寫。
    const digest = new crypto.DigestStream("SHA-256");
    const dw = digest.getWriter();
    const exists = await c.env.MEDIA.head(a.r2_key);
    const tmpKey = exists ? null : a.r2_key;
    let rw: WritableStreamDefaultWriter<Uint8Array> | null = null;
    let putP: Promise<unknown> = Promise.resolve();
    if (tmpKey) {
      const fl = new FixedLengthStream(len);
      rw = fl.writable.getWriter();
      putP = c.env.MEDIA.put(tmpKey, fl.readable, { httpMetadata: { contentType: a.mime, cacheControl: "public, max-age=31536000, immutable" } });
    }
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await Promise.all([dw.write(value), rw?.write(value)]);
      }
      await Promise.all([dw.close(), rw?.close()]);
      await putP;
    } catch {
      if (tmpKey) await c.env.MEDIA.delete(tmpKey).catch(() => {});
      await c.env.DB.prepare("DELETE FROM ad_assets WHERE id=?").bind(a.id).run();
      return err(c, 422, "SIZE_MISMATCH");
    }
    const hash = toHex(new Uint8Array(await digest.digest));
    if (hash !== a.sha256) {
      if (tmpKey) await c.env.MEDIA.delete(tmpKey);
      await c.env.DB.prepare("DELETE FROM ad_assets WHERE id=?").bind(a.id).run();
      return err(c, 422, "HASH_MISMATCH");
    }
    const used = await usedBytes(c, sid);
    const quota = c.get("rec").adQuotaBytes;
    if (used + a.bytes > quota) {
      if (tmpKey) await c.env.MEDIA.delete(tmpKey);
      await c.env.DB.prepare("DELETE FROM ad_assets WHERE id=?").bind(a.id).run();
      return err(c, 409, "QUOTA_EXCEEDED", { used, quota });
    }
    const pl = await playlist(c, sid);
    const max = (await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order),-1) AS m FROM ad_playlist_items WHERE playlist_id=?").bind(pl.id).first<{ m: number }>())!.m;
    const itemId = ulid(now());
    const version = await bump(c, [
      c.env.DB.prepare("UPDATE ad_assets SET status='ready' WHERE id=?").bind(a.id),
      c.env.DB.prepare(
        "INSERT INTO ad_playlist_items(id,playlist_id,asset_id,sort_order,duration_ms,active_dows,enabled) VALUES(?,?,?,?,?,'[0,1,2,3,4,5,6]',1)",
      ).bind(itemId, pl.id, a.id, max + 1, a.kind === "image" ? DEFAULT_IMAGE_MS : null),
      audit(c, "ad.upload", a.id, { kind: a.kind, bytes: a.bytes }),
    ]);
    return c.json({ ok: true, itemId, version });
  });

  r.put("/ads/items/:id", async (c) => {
    const b = await c.req.json().catch(() => null);
    const sid = c.get("admin").store_id;
    const it = await c.env.DB.prepare(
      "SELECT i.id, a.kind FROM ad_playlist_items i JOIN ad_playlists p ON p.id=i.playlist_id JOIN ad_assets a ON a.id=i.asset_id WHERE i.id=? AND p.owner_type='store' AND p.owner_id=?",
    ).bind(c.req.param("id"), sid).first<{ id: string; kind: string }>();
    if (!it) return err(c, 404, "NOT_FOUND");
    const t = (x: unknown) => (x === null || x === undefined || x === "" ? null : x);
    const from = t(b?.activeFrom);
    const to = t(b?.activeTo);
    const sd = t(b?.startDate);
    const ed = t(b?.endDate);
    const ms = it.kind === "image" ? b?.imageMs : null;
    const ok =
      (it.kind !== "image" || isInt(ms, 1000, 600_000)) &&
      typeof b?.enabled === "boolean" &&
      (from === null || HHMM.test(String(from))) &&
      (to === null || HHMM.test(String(to))) &&
      !(from && to && String(from) >= String(to)) &&
      Array.isArray(b?.dows) &&
      b.dows.length > 0 &&
      b.dows.every((d: unknown) => isInt(d, 0, 6)) &&
      (sd === null || YMD.test(String(sd))) &&
      (ed === null || YMD.test(String(ed))) &&
      !(sd && ed && String(sd) > String(ed));
    if (!ok) return err(c, 422, "INVALID");
    const dows = JSON.stringify([...new Set(b.dows as number[])].sort());
    const version = await bump(c, [
      c.env.DB.prepare("UPDATE ad_playlist_items SET duration_ms=?, enabled=?, active_from=?, active_to=?, active_dows=?, start_date=?, end_date=? WHERE id=?").bind(
        ms,
        b.enabled ? 1 : 0,
        from,
        to,
        dows,
        sd,
        ed,
        it.id,
      ),
    ]);
    return c.json({ ok: true, version });
  });

  r.post("/ads/order", async (c) => {
    const b = await c.req.json().catch(() => null);
    const ids: unknown = b?.itemIds;
    const sid = c.get("admin").store_id;
    const pl = await playlist(c, sid);
    const mine = (await c.env.DB.prepare("SELECT id FROM ad_playlist_items WHERE playlist_id=?").bind(pl.id).all<{ id: string }>()).results.map((x) => x.id);
    if (!Array.isArray(ids) || ids.length !== mine.length || new Set(ids).size !== ids.length || !ids.every((x) => mine.includes(x as string))) return err(c, 422, "INVALID");
    const version = await bump(
      c,
      (ids as string[]).map((id, i) => c.env.DB.prepare("UPDATE ad_playlist_items SET sort_order=? WHERE id=?").bind(i, id)),
    );
    return c.json({ ok: true, version });
  });

  r.delete("/ads/items/:id", async (c) => {
    const sid = c.get("admin").store_id;
    const it = await c.env.DB.prepare(
      "SELECT i.id, a.id AS asset_id, a.r2_key FROM ad_playlist_items i JOIN ad_playlists p ON p.id=i.playlist_id JOIN ad_assets a ON a.id=i.asset_id WHERE i.id=? AND p.owner_type='store' AND p.owner_id=?",
    ).bind(c.req.param("id"), sid).first<any>();
    if (!it) return err(c, 404, "NOT_FOUND");
    const version = await bump(c, [
      c.env.DB.prepare("DELETE FROM ad_playlist_items WHERE id=?").bind(it.id),
      c.env.DB.prepare("UPDATE ad_assets SET status='deleted' WHERE id=?").bind(it.asset_id),
      audit(c, "ad.delete", it.asset_id, null),
    ]);
    const still = await c.env.DB.prepare("SELECT 1 FROM ad_assets WHERE r2_key=? AND status IN ('ready','uploading')").bind(it.r2_key).first();
    if (!still) await c.env.MEDIA.delete(it.r2_key);
    return c.json({ ok: true, version });
  });
}

/** 本機才有：模擬 media.<domain>（R2 自訂網域）。production 由 R2 自訂網域直接提供，不經 Worker。 */
export async function serveLocalMedia(c: C): Promise<Response> {
  if (c.env.ENV !== "local") return err(c, 404, "NOT_FOUND");
  const key = decodeURIComponent(c.req.path.replace(/^\/media\//, ""));
  const range = c.req.header("range");
  const obj = await c.env.MEDIA.get(key, range ? { range: c.req.raw.headers } : {});
  if (!obj) return err(c, 404, "NOT_FOUND");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-allow-origin", "*");
  if (range && obj.range && "offset" in obj.range) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    headers.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

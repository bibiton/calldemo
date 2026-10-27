import { describe, expect, it } from "vitest";
import { toHex } from "@qcs/shared";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { seedStore, type Seeded } from "./fixtures";

const app = createApp();
const MB = 1024 * 1024;

function req(path: string, init: { method?: string; token?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}, e: any = env) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return app.request(path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body }, e);
}
async function admin(s: Seeded) {
  return ((await (await req("/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } })).json()) as any).accessToken as string;
}
const sha = async (b: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

async function upload(token: string, data: Uint8Array, meta: Record<string, unknown> = {}) {
  const init = await req("/api/store/ads/uploads", {
    token,
    body: { kind: "image", mime: "image/png", bytes: data.length, sha256: await sha(data), width: 1080, height: 720, name: "促銷.png", ...meta },
  });
  if (init.status !== 200) return { init, put: null as Response | null, body: (await init.json()) as any };
  const b: any = await init.json();
  const put = await req(b.uploadUrl, { method: "PUT", token, raw: data, headers: { "content-type": String(meta.mime ?? "image/png"), "content-length": String(data.length) } });
  return { init, put, body: b };
}
const list = async (token: string) => (await (await req("/api/store/ads", { token })).json()) as any;

describe("3.4 廣告管理：上傳到 R2、容量、排序、秒數、時段", () => {
  it("上傳 → R2 物件（內容定址 ads/<store>/<sha256>.png）→ 清單與面板 manifest 出現、版本 +1、面板收到 ads.manifest", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const ws = await app.request(`/ws/store/${s.storeId}?role=display`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${s.displayToken}` } }, env);
    const sock = ws.webSocket!;
    sock.accept();
    const got: any[] = [];
    sock.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));

    const data = bytes(2048);
    const { put } = await upload(t, data);
    expect(put!.status).toBe(200);
    const l = await list(t);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ kind: "image", mime: "image/png", bytes: 2048, width: 1080, height: 720, enabled: true, imageMs: 8000, name: "促銷.png" });
    expect(l.usedBytes).toBe(2048);
    expect(l.quotaBytes).toBe(524288000);
    const key = `ads/${s.storeId}/${await sha(data)}.png`;
    const obj = await env.MEDIA.get(key);
    expect(obj).not.toBeNull();
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(data);
    const m: any = await (await req("/api/display/ads/manifest", { token: s.displayToken })).json();
    expect(m.version).toBe(l.version);
    expect(m.items[0].url).toBe(`${env.MEDIA_BASE}/${key}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.some((x) => x.type === "ads.manifest" && x.data.version === l.version)).toBe(true);
    sock.close();
    const a = (await env.DB.prepare("SELECT action FROM audit_logs WHERE store_id=?").bind(s.storeId).all()).results.map((r: any) => r.action);
    expect(a).toContain("ad.upload");
  });

  it("超過大小／長度／格式 → 422（圖片 ≤ 5 MB、影片 ≤ 50 MB 且 ≤ 120 秒）", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const base = { sha256: "a".repeat(64), width: 1080, height: 720 };
    const cases = [
      { kind: "image", mime: "image/png", bytes: 5 * MB + 1 },
      { kind: "video", mime: "video/mp4", bytes: 50 * MB + 1, durationMs: 10_000 },
      { kind: "video", mime: "video/mp4", bytes: 1000, durationMs: 120_001 },
      { kind: "image", mime: "image/gif", bytes: 1000 },
      { kind: "video", mime: "video/webm", bytes: 1000, durationMs: 1000 },
      { kind: "image", mime: "image/png", bytes: 0 },
    ];
    for (const c of cases) {
      const r = await req("/api/store/ads/uploads", { token: t, body: { ...base, ...c } });
      expect(r.status, JSON.stringify(c)).toBe(422);
    }
  });

  it("超過門店廣告容量 → 409 QUOTA_EXCEEDED（含已用／上限）", async () => {
    const s = await seedStore({ adQuota: 3000 });
    const t = await admin(s);
    expect((await upload(t, bytes(2000, 1))).put!.status).toBe(200);
    const r = await upload(t, bytes(1500, 2));
    expect(r.init.status).toBe(409);
    expect(r.body).toMatchObject({ code: "QUOTA_EXCEEDED", used: 2000, quota: 3000 });
  });

  it("上傳內容與宣告不符（大小或 SHA-256）→ 422，R2 不留檔、不列入清單", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const data = bytes(1000, 3);
    const init: any = await (await req("/api/store/ads/uploads", { token: t, body: { kind: "image", mime: "image/png", bytes: 1000, sha256: "b".repeat(64), width: 10, height: 10 } })).json();
    const put = await req(init.uploadUrl, { method: "PUT", token: t, raw: data, headers: { "content-type": "image/png", "content-length": "1000" } });
    expect(put.status).toBe(422);
    expect(((await put.json()) as any).code).toBe("HASH_MISMATCH");
    expect(await env.MEDIA.get(`ads/${s.storeId}/${"b".repeat(64)}.png`)).toBeNull();
    expect((await list(t)).items).toHaveLength(0);
    const init2: any = await (await req("/api/store/ads/uploads", { token: t, body: { kind: "image", mime: "image/png", bytes: 999, sha256: await sha(data), width: 10, height: 10 } })).json();
    const put2 = await req(init2.uploadUrl, { method: "PUT", token: t, raw: data, headers: { "content-type": "image/png", "content-length": "1000" } });
    expect(put2.status).toBe(422);
  });

  it("修改秒數／啟停／時段／星期／日期；格式錯 → 422；排序；刪除後 R2 物件移除、容量釋放", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const d1 = bytes(1000, 5);
    const d2 = bytes(1200, 6);
    await upload(t, d1, { name: "一.png" });
    await upload(t, d2, { name: "二.png" });
    let l = await list(t);
    const [a, b] = l.items;
    const v0 = l.version;
    const upd = { imageMs: 12000, enabled: false, activeFrom: "11:00", activeTo: "14:00", dows: [1, 2, 3], startDate: "2026-11-01", endDate: "2026-11-30" };
    expect((await req(`/api/store/ads/items/${a.itemId}`, { method: "PUT", token: t, body: upd })).status).toBe(200);
    for (const bad of [{ imageMs: 500 }, { activeFrom: "25:00" }, { activeFrom: "14:00", activeTo: "11:00" }, { dows: [7] }, { startDate: "2026-13-01" }, { startDate: "2026-11-30", endDate: "2026-11-01" }]) {
      expect((await req(`/api/store/ads/items/${a.itemId}`, { method: "PUT", token: t, body: { ...upd, ...bad } })).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await req("/api/store/ads/order", { token: t, body: { itemIds: [b.itemId, a.itemId] } })).status).toBe(200);
    l = await list(t);
    expect(l.items.map((x: any) => x.itemId)).toEqual([b.itemId, a.itemId]);
    expect(l.items[1]).toMatchObject(upd);
    expect(l.version).toBeGreaterThan(v0);
    // 停用的項目不進面板 manifest
    const m: any = await (await req("/api/display/ads/manifest", { token: s.displayToken })).json();
    expect(m.items.map((x: any) => x.assetId)).toEqual([b.assetId]);
    expect((await req(`/api/store/ads/items/${b.itemId}`, { method: "DELETE", token: t })).status).toBe(200);
    l = await list(t);
    expect(l.items.map((x: any) => x.itemId)).toEqual([a.itemId]);
    expect(l.usedBytes).toBe(1000);
    expect(await env.MEDIA.get(`ads/${s.storeId}/${await sha(d2)}.png`)).toBeNull();
    const aud = (await env.DB.prepare("SELECT action FROM audit_logs WHERE store_id=?").bind(s.storeId).all()).results.map((r: any) => r.action);
    expect(aud).toContain("ad.delete");
  });

  it("排序清單必須是本店全部項目（不可帶別店或缺項）", async () => {
    const s = await seedStore();
    const t = await admin(s);
    await upload(t, bytes(100, 7));
    const l = await list(t);
    expect((await req("/api/store/ads/order", { token: t, body: { itemIds: [] } })).status).toBe(422);
    expect((await req("/api/store/ads/order", { token: t, body: { itemIds: [l.items[0].itemId, "x"] } })).status).toBe(422);
  });

  it("本機 /media/* 由 R2 提供（支援 Range）；非本機環境 404", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const data = bytes(4000, 9);
    await upload(t, data);
    const key = `ads/${s.storeId}/${await sha(data)}.png`;
    const r = await req(`/media/${key}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(data);
    const part = await req(`/media/${key}`, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/4000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.slice(10, 20));
    expect((await req(`/media/${key}`, {}, { ...env, ENV: "staging", DEV_BYPASS_ACCESS: undefined })).status).toBe(404);
  });
});

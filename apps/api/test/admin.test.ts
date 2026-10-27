/**
 * M4 4.2 總後台 API（本機繞過 Access；Access 本身見 access.test.ts）：
 * 品牌、門店增刪改、開通／停用／到期／上限／功能開關／廣告容量、店長帳號、面板在線與無法出聲、稽核。
 */
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { writeHistory } from "../src/queue-consumer";
import { seedStore } from "./fixtures";
import { isType, openWs, storeCtx, stubFor } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";

const NOW = Date.now();
const app = createApp({ now: () => NOW });
const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
const send = (method: string, path: string, body?: unknown) =>
  req(path, { method, headers: { "content-type": "application/json", "x-qcs-admin": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
const j = async (r: Response) => (await r.json()) as any;
let n = 0;
const code = () => `T${(Date.now() % 100000).toString(36).toUpperCase()}${(n++).toString(36).toUpperCase()}`.slice(0, 8);

async function createStore(over: Record<string, unknown> = {}) {
  const c = code();
  const res = await send("POST", "/api/admin/stores", {
    name: "新開店",
    code: c,
    timezone: "Asia/Taipei",
    admin: { email: `${c.toLowerCase()}@example.com`, displayName: "王店長" },
    ...over,
  });
  return { res, body: await j(res), code: c };
}

async function storeLogin(email: string, password: string) {
  return send("POST", "/api/store/auth/login", { email, password });
}

describe("品牌", () => {
  it("新增、改名、列表含門店數；有門店的品牌不能刪；沒有門店的可以刪；皆寫稽核", async () => {
    const r = await send("POST", "/api/admin/brands", { name: "壽司王" });
    expect(r.status).toBe(200);
    const b = (await j(r)).brand;
    expect((await send("PUT", `/api/admin/brands/${b.id}`, { name: "壽司王國" })).status).toBe(200);
    const s = await createStore({ brandId: b.id });
    expect(s.res.status).toBe(200);
    const list = (await j(await req("/api/admin/brands"))).brands;
    expect(list.find((x: any) => x.id === b.id)).toMatchObject({ name: "壽司王國", stores: 1 });
    const del = await send("DELETE", `/api/admin/brands/${b.id}`);
    expect(del.status).toBe(409);
    expect(await j(del)).toMatchObject({ code: "BRAND_IN_USE" });
    const b2 = (await j(await send("POST", "/api/admin/brands", { name: "空品牌" }))).brand;
    expect((await send("DELETE", `/api/admin/brands/${b2.id}`)).status).toBe(200);
    const acts = await env.DB.prepare("SELECT action FROM audit_logs WHERE target IN (?,?) ORDER BY at").bind(b.id, b2.id).all<any>();
    expect(acts.results.map((x) => x.action)).toEqual(expect.arrayContaining(["brand.create", "brand.update", "brand.delete"]));
  });
  it("名稱空白 → 422", async () => {
    expect((await send("POST", "/api/admin/brands", { name: "  " })).status).toBe(422);
  });
});

describe("建立門店", () => {
  it("建立後回傳初始密碼（只此一次）；店長可用它登入；門店碼可用於取號網址；寫稽核", async () => {
    const { res, body, code: c } = await createStore();
    expect(res.status).toBe(200);
    expect(body.store).toMatchObject({ code: c, name: "新開店", status: "active", maxDevices: 2, maxStaff: 10 });
    expect(body.admin.initialPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await storeLogin(body.admin.email, body.admin.initialPassword)).status).toBe(200);
    const kv = await env.LICENSE.get(`storecode:${c}`);
    expect(kv).toBe(body.store.id);
    const a = await env.DB.prepare("SELECT actor_type, actor_id, detail FROM audit_logs WHERE store_id=? AND action='store.create'").bind(body.store.id).first<any>();
    expect(a).toMatchObject({ actor_type: "platform_admin", actor_id: "dev@local" });
    expect(a.detail).not.toContain(body.admin.initialPassword);
    // 詳情不會再回傳密碼
    const d = await j(await req(`/api/admin/stores/${body.store.id}`));
    expect(JSON.stringify(d)).not.toContain(body.admin.initialPassword);
  });
  it("不給門店碼時自動產生 6 碼（不含易混淆字元）", async () => {
    const c = code();
    const r = await send("POST", "/api/admin/stores", { name: "自動碼", timezone: "Asia/Taipei", admin: { email: `auto${c}@example.com`, displayName: "店長" } });
    expect(r.status).toBe(200);
    expect((await j(r)).store.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
  it("門店碼重複 → 409 CODE_TAKEN；Email 已被使用 → 409 EMAIL_TAKEN；時區錯誤 → 422", async () => {
    const first = await createStore();
    const dup = await send("POST", "/api/admin/stores", { name: "x", code: first.code, timezone: "Asia/Taipei", admin: { email: `zz${code()}@example.com`, displayName: "店長" } });
    expect(dup.status).toBe(409);
    expect(await j(dup)).toMatchObject({ code: "CODE_TAKEN" });
    const em = await send("POST", "/api/admin/stores", { name: "x", code: code(), timezone: "Asia/Taipei", admin: { email: first.body.admin.email, displayName: "店長" } });
    expect(em.status).toBe(409);
    expect(await j(em)).toMatchObject({ code: "EMAIL_TAKEN" });
    const tz = await send("POST", "/api/admin/stores", { name: "x", code: code(), timezone: "Mars/Olympus", admin: { email: `tz${code()}@example.com`, displayName: "店長" } });
    expect(tz.status).toBe(422);
  });
  it("欄位驗證：名稱空白、門店碼格式、Email 格式 → 422；失敗時不留下半套資料", async () => {
    const c = code();
    for (const body of [
      { name: "", code: c, timezone: "Asia/Taipei", admin: { email: `a${c}@example.com`, displayName: "店長" } },
      { name: "x", code: "ab", timezone: "Asia/Taipei", admin: { email: `a${c}@example.com`, displayName: "店長" } },
      { name: "x", code: c, timezone: "Asia/Taipei", admin: { email: "not-an-email", displayName: "店長" } },
      { name: "x", code: c, timezone: "Asia/Taipei", maxDevices: -1, admin: { email: `a${c}@example.com`, displayName: "店長" } },
    ]) {
      expect((await send("POST", "/api/admin/stores", body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await env.DB.prepare("SELECT id FROM stores WHERE code=?").bind(c).first()).toBeNull();
  });
});

describe("門店列表與詳情", () => {
  it("搜尋名稱／門店碼、依狀態篩選；到期顯示 expired；面板數 x / 上限", async () => {
    const s = await seedStore({ expiresAt: NOW - 1000 });
    const list = (await j(await req(`/api/admin/stores?q=${s.code}`))).stores;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: s.storeId, status: "expired", displays: 1, maxDevices: 2 });
    const exp = (await j(await req(`/api/admin/stores?status=expired&q=${s.code}`))).stores;
    expect(exp).toHaveLength(1);
    expect((await j(await req(`/api/admin/stores?status=active&q=${s.code}`))).stores).toHaveLength(0);
  });

  it("詳情：上限、功能開關、店長帳號、裝置、廣告用量；不含任何顧客個資", async () => {
    const s = await seedStore();
    const d = await j(await req(`/api/admin/stores/${s.storeId}`));
    expect(d.store).toMatchObject({ id: s.storeId, status: "active", maxDevices: 2, maxStaff: 10, adQuotaBytes: 524288000 });
    expect(d.admins).toEqual([expect.objectContaining({ email: s.adminEmail, status: "active" })]);
    expect(d.devices.map((x: any) => x.kind).sort()).toEqual(["display", "staff_device"]);
    expect(d.adBytes).toBe(0);
    expect(d.counts).toMatchObject({ staff: 1, services: 2, counters: 1 });
    expect(JSON.stringify(d)).not.toMatch(/password|pin_hash|phone/i);
  });

  it("不存在的門店 → 404", async () => {
    expect((await req("/api/admin/stores/nope")).status).toBe(404);
  });
});

describe("開通、停用、到期、上限、功能開關（06 §2）", () => {
  it("停用：店長 API 403、已連線的面板 WS 立即以 4003 關閉；恢復後恢復", async () => {
    const s = await seedStore();
    const ws = await openWs(s.storeId, { role: "display", deviceId: `${s.storeId}_d1` }, { ctx: storeCtx(s.storeId) });
    await ws.next(isType("snapshot"));
    expect((await send("POST", `/api/admin/stores/${s.storeId}/suspend`)).status).toBe(200);
    await ws.next(isType("store.suspended"));
    expect(await ws.closed).toBe(4003);
    expect((await storeLogin(s.adminEmail, s.adminPassword)).status).toBe(403);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/resume`)).status).toBe(200);
    expect((await storeLogin(s.adminEmail, s.adminPassword)).status).toBe(200);
  });

  it("到期日改到過去：立即 403 STORE_EXPIRED 且 WS 斷線；延期後恢復；寫 store.extend 稽核", async () => {
    const s = await seedStore();
    const ws = await openWs(s.storeId, { role: "display", deviceId: `${s.storeId}_d1` }, { ctx: storeCtx(s.storeId) });
    await ws.next(isType("snapshot"));
    expect((await send("PUT", `/api/admin/stores/${s.storeId}`, { expiresAt: NOW - 60_000 })).status).toBe(200);
    expect(await ws.closed).toBe(4003);
    const login = await storeLogin(s.adminEmail, s.adminPassword);
    expect(login.status).toBe(403);
    expect(await j(login)).toMatchObject({ code: "STORE_EXPIRED" });
    expect((await send("PUT", `/api/admin/stores/${s.storeId}`, { expiresAt: NOW + 30 * 86400_000 })).status).toBe(200);
    expect((await storeLogin(s.adminEmail, s.adminPassword)).status).toBe(200);
    const acts = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE store_id=? AND action='store.extend'").bind(s.storeId).all<any>();
    expect(acts.results.length).toBe(2);
  });

  it("上限、功能開關、廣告容量：寫 D1＋KV，店長端立即看到新上限；功能開關保留其他鍵", async () => {
    const s = await seedStore();
    await env.DB.prepare("UPDATE stores SET features=? WHERE id=?").bind(JSON.stringify({ push: true, demo: true }), s.storeId).run();
    const r = await send("PUT", `/api/admin/stores/${s.storeId}`, {
      maxDevices: 5,
      maxStaff: 3,
      adQuotaBytes: 100 * 1024 * 1024,
      features: { push: false, ads: true, voice: true, showMaskedName: true, internal: false },
      name: "改名店",
    });
    expect(r.status).toBe(200);
    const kv = await env.LICENSE.get<any>(`license:${s.storeId}`, { type: "json" });
    expect(kv).toMatchObject({ maxDevices: 5, maxStaff: 3, adQuotaBytes: 104857600 });
    expect(kv.store.features).toMatchObject({ push: false, ads: true, showMaskedName: true, demo: true });
    expect(kv.store.name).toBe("改名店");
    const login = await j(await storeLogin(s.adminEmail, s.adminPassword));
    const me = await j(await req("/api/store/me", { headers: { authorization: `Bearer ${login.accessToken}` } }));
    expect(me.limits).toMatchObject({ maxDevices: 5, maxStaff: 3, adQuotaBytes: 104857600 });
    const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE store_id=? AND action='store.update'").bind(s.storeId).first<any>();
    expect(a).not.toBeNull();
  });

  it("上限調低後：新增人員超過上限被擋（409 STAFF_LIMIT）", async () => {
    const s = await seedStore();
    expect((await send("PUT", `/api/admin/stores/${s.storeId}`, { maxStaff: 1 })).status).toBe(200);
    const login = await j(await storeLogin(s.adminEmail, s.adminPassword));
    const r = await req("/api/store/staff", { method: "POST", headers: { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ displayName: "新人" }) });
    expect(r.status).toBe(409);
  });

  it("輸入驗證：負數上限、非布林功能開關、未知欄位型別 → 422，不寫入", async () => {
    const s = await seedStore();
    for (const body of [{ maxDevices: -1 }, { maxStaff: 0 }, { adQuotaBytes: -5 }, { features: { push: "yes" } }, { expiresAt: "明天" }, { timezone: "X/Y" }, { name: "" }]) {
      expect((await send("PUT", `/api/admin/stores/${s.storeId}`, body)).status, JSON.stringify(body)).toBe(422);
    }
    const row = await env.DB.prepare("SELECT max_devices, name FROM stores WHERE id=?").bind(s.storeId).first<any>();
    expect(row).toMatchObject({ max_devices: 2, name: "測試店" });
  });
});

describe("刪除門店（封存，ADR-043）", () => {
  it("需輸入門店碼確認；封存後列表預設不顯示、裝置與店長失效、WS 斷線；資料列保留", async () => {
    const s = await seedStore();
    const ws = await openWs(s.storeId, { role: "display", deviceId: `${s.storeId}_d1` }, { ctx: storeCtx(s.storeId) });
    await ws.next(isType("snapshot"));
    expect((await send("DELETE", `/api/admin/stores/${s.storeId}`, { confirmCode: "WRONG" })).status).toBe(422);
    expect((await send("DELETE", `/api/admin/stores/${s.storeId}`, { confirmCode: s.code })).status).toBe(200);
    expect(await ws.closed).toBe(4003);
    expect((await j(await req(`/api/admin/stores?q=${s.code}`))).stores).toHaveLength(0);
    expect((await j(await req(`/api/admin/stores?q=${s.code}&status=deleted`))).stores).toHaveLength(1);
    const dev = await env.DB.prepare("SELECT status FROM devices WHERE store_id=?").bind(s.storeId).all<any>();
    expect(dev.results.every((d) => d.status === "revoked")).toBe(true);
    const u = await env.DB.prepare("SELECT status FROM users WHERE store_id=?").bind(s.storeId).all<any>();
    expect(u.results.every((d) => d.status === "disabled")).toBe(true);
    expect((await storeLogin(s.adminEmail, s.adminPassword)).status).toBe(401);
    expect(await env.DB.prepare("SELECT id FROM stores WHERE id=?").bind(s.storeId).first()).not.toBeNull();
    // 已封存的不能再恢復營業
    expect((await send("POST", `/api/admin/stores/${s.storeId}/resume`)).status).toBe(409);
  });
});

describe("店長帳號", () => {
  it("新增第二位店長、重設密碼（舊密碼失效、解鎖）、停用／啟用；皆寫稽核", async () => {
    const s = await seedStore();
    const e2 = `second-${s.storeId}@example.com`;
    const c = await send("POST", `/api/admin/stores/${s.storeId}/admins`, { email: e2, displayName: "副店長" });
    expect(c.status).toBe(200);
    const { admin } = await j(c);
    expect((await storeLogin(e2, admin.initialPassword)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET locked_until=? WHERE id=?").bind(NOW + 600_000, s.adminId).run();
    const rs = await send("POST", `/api/admin/stores/${s.storeId}/admins/${s.adminId}/reset-password`);
    expect(rs.status).toBe(200);
    const pw = (await j(rs)).password;
    expect((await storeLogin(s.adminEmail, s.adminPassword)).status).toBe(401);
    expect((await storeLogin(s.adminEmail, pw)).status).toBe(200);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins/${admin.id}/disable`)).status).toBe(200);
    expect((await storeLogin(e2, admin.initialPassword)).status).toBe(401);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins/${admin.id}/enable`)).status).toBe(200);
    expect((await storeLogin(e2, admin.initialPassword)).status).toBe(200);
    const acts = await env.DB.prepare("SELECT action FROM audit_logs WHERE store_id=? AND action LIKE 'user.%' ORDER BY at, rowid").bind(s.storeId).all<any>();
    expect(acts.results.map((x) => x.action)).toEqual(["user.create", "user.reset", "user.disable", "user.enable"]);
  });
  it("Email 重複 → 409；別店的帳號 id → 404", async () => {
    const s = await seedStore();
    const t = await seedStore();
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins`, { email: t.adminEmail, displayName: "x" })).status).toBe(409);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins/${t.adminId}/disable`)).status).toBe(404);
  });
});

describe("面板在線與「無法出聲」（ADR-027、ADR-045）", () => {
  it("詳情的 live 來自 DO：連線中的面板與音訊狀態", async () => {
    const s = await seedStore();
    const ctx = storeCtx(s.storeId);
    const ws = await openWs(s.storeId, { role: "display", deviceId: `${s.storeId}_d1` }, { ctx });
    await ws.next(isType("snapshot"));
    await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => (i.captureHistory = true));
    ws.send({ t: "status", audio: "blocked", client: "browser" });
    await new Promise((r) => setTimeout(r, 50));
    const d = await j(await req(`/api/admin/stores/${s.storeId}`));
    expect(d.live).toEqual([{ deviceId: `${s.storeId}_d1`, audio: "blocked", client: "browser" }]);
    ws.ws.close();
  });

  it("音訊狀態改變立即送 q-history（不等 25 筆批次）；consumer 依時間只套用較新的狀態", async () => {
    const s = await seedStore();
    const ws = await openWs(s.storeId, { role: "display", deviceId: `${s.storeId}_d1` }, { ctx: storeCtx(s.storeId) });
    await ws.next(isType("snapshot"));
    await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => (i.captureHistory = true));
    ws.send({ t: "status", audio: "blocked", client: "android_app" });
    await new Promise((r) => setTimeout(r, 50));
    const sent: any[] = await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => i.captured);
    const msg = sent.find((m) => m.devices?.length);
    expect(msg.devices[0]).toMatchObject({ deviceId: `${s.storeId}_d1`, audio: "blocked", client: "android_app" });
    await writeHistory(env, msg);
    let row = await env.DB.prepare("SELECT audio_status, client_kind FROM devices WHERE id=?").bind(`${s.storeId}_d1`).first<any>();
    expect(row).toMatchObject({ audio_status: "blocked", client_kind: "android_app" });
    // 較舊的訊息晚到 → 不覆蓋
    await writeHistory(env, { ...msg, devices: [{ ...msg.devices[0], audio: "ok", at: msg.devices[0].at - 1000 }] });
    row = await env.DB.prepare("SELECT audio_status FROM devices WHERE id=?").bind(`${s.storeId}_d1`).first<any>();
    expect(row.audio_status).toBe("blocked");
    // 面板斷線時若仍是 blocked → 送 offline，警示不會殘留
    ws.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const sent2: any[] = await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => i.captured);
    const off = sent2.flatMap((m) => m.devices ?? []).find((d: any) => d.audio === "offline");
    expect(off).toBeTruthy();
  });

  it("門店列表：任一面板 blocked 超過 5 分鐘 → 警示 panel_muted；未滿 5 分鐘不警示", async () => {
    const s = await seedStore();
    await env.DB.prepare("UPDATE devices SET audio_status='blocked', audio_status_at=? WHERE id=?").bind(NOW - 2 * 60_000, `${s.storeId}_d1`).run();
    let st = (await j(await req(`/api/admin/stores?q=${s.code}`))).stores[0];
    expect(st.alerts.map((a: any) => a.kind)).not.toContain("panel_muted");
    await env.DB.prepare("UPDATE devices SET audio_status_at=? WHERE id=?").bind(NOW - 6 * 60_000, `${s.storeId}_d1`).run();
    st = (await j(await req(`/api/admin/stores?q=${s.code}`))).stores[0];
    expect(st.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "panel_muted", level: "red" })]));
  });
});

describe("安全審查修正：封存門店、搜尋萬用字元、密碼回應不快取", () => {
  it("已刪除（封存）的門店不能新增或啟用店長（409）", async () => {
    const s = await seedStore();
    expect((await send("DELETE", `/api/admin/stores/${s.storeId}`, { confirmCode: s.code })).status).toBe(200);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins`, { email: `z-${s.storeId}@example.com`, displayName: "x" })).status).toBe(409);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins/${s.adminId}/enable`)).status).toBe(409);
    expect((await send("POST", `/api/admin/stores/${s.storeId}/admins/${s.adminId}/reset-password`)).status).toBe(409);
  });
  it("搜尋的 % 與 _ 當一般字元（不當萬用字元）", async () => {
    await seedStore();
    expect((await j(await req("/api/admin/stores?q=%25"))).stores).toHaveLength(0);
    expect((await j(await req("/api/admin/stores?q=_"))).stores).toHaveLength(0);
  });
  it("回傳密碼的回應帶 Cache-Control: no-store", async () => {
    const { res } = await createStore();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const s = await seedStore();
    const r = await send("POST", `/api/admin/stores/${s.storeId}/admins/${s.adminId}/reset-password`);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("稽核查詢", () => {
  it("依門店與動作篩選、分頁（before 游標）、含操作者；detail 不含個資", async () => {
    const s = await seedStore();
    for (let i = 0; i < 3; i++) {
      await send("POST", `/api/admin/stores/${s.storeId}/suspend`);
      await send("POST", `/api/admin/stores/${s.storeId}/resume`);
    }
    const p1 = await j(await req(`/api/admin/audit?storeId=${s.storeId}&limit=4`));
    expect(p1.items).toHaveLength(4);
    expect(p1.items[0]).toMatchObject({ actorType: "platform_admin", actorId: "dev@local", storeId: s.storeId, storeName: "測試店" });
    expect(p1.next).toBeTruthy();
    const p2 = await j(await req(`/api/admin/audit?storeId=${s.storeId}&limit=4&before=${encodeURIComponent(p1.next)}`));
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((x: any) => x.id)).size).toBe(6);
    const only = await j(await req(`/api/admin/audit?storeId=${s.storeId}&action=store.suspend`));
    expect(only.items.every((x: any) => x.action === "store.suspend")).toBe(true);
    expect(JSON.stringify([...p1.items, ...p2.items])).not.toMatch(/09\d{8}/);
  });
});

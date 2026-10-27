import { describe, expect, it } from "vitest";
import { computeQrToken, deriveStoreKey, qrWindow } from "@qcs/shared";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { seedStore, type Seeded } from "./fixtures";
import { isType, openWs, storeCtx } from "./helpers";

type App = ReturnType<typeof createApp>;
const mk = (now?: () => number) => createApp(now ? { now } : {});

function req(app: App, path: string, init: { method?: string; token?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;
  if (path.startsWith("/api/admin/")) headers["x-qcs-admin"] = "1"; // 總後台寫入的 CSRF 標頭
  return app.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }, env);
}

async function login(s: Seeded, app: App = mk()) {
  const r = await req(app, "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } });
  expect(r.status).toBe(200);
  const b: any = await r.json();
  return { token: b.accessToken as string, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], body: b };
}

const audits = async (storeId: string) =>
  ((await env.DB.prepare("SELECT action, actor_type, detail FROM audit_logs WHERE store_id=? ORDER BY at").bind(storeId).all()).results as any[]).map((r) => r.action);

describe("3.1 店長登入（email＋密碼，PBKDF2；access 15 分鐘＋refresh HttpOnly cookie 14 天）", () => {
  it("正確 → access token＋HttpOnly SameSite=Strict refresh cookie；錯密碼 → 401", async () => {
    const s = await seedStore();
    const app = mk();
    const r = await req(app, "/api/store/auth/login", { body: { email: s.adminEmail.toUpperCase(), password: s.adminPassword } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.user).toMatchObject({ id: s.adminId, displayName: "店長" });
    expect(b.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const ck = r.headers.get("set-cookie")!;
    expect(ck).toMatch(/^qcs_rt=/);
    expect(ck).toMatch(/HttpOnly/i);
    expect(ck).toMatch(/SameSite=Strict/i);
    expect(ck).toMatch(/Path=\/api\/store\/auth/);
    expect(ck).toMatch(/Max-Age=1209600/);
    expect((await req(app, "/api/store/auth/login", { body: { email: s.adminEmail, password: "nope" } })).status).toBe(401);
    expect((await req(app, "/api/store/auth/login", { body: { email: "nobody@example.com", password: "x" } })).status).toBe(401);
  });

  it("連錯 5 次鎖 15 分鐘（正確密碼也進不去）＋寫稽核；15 分鐘後可登入", async () => {
    const s = await seedStore();
    const app = mk();
    for (let i = 0; i < 5; i++) await req(app, "/api/store/auth/login", { body: { email: s.adminEmail, password: "bad" } });
    expect((await req(app, "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } })).status).toBe(423);
    expect(await audits(s.storeId)).toContain("user.locked");
    const later = mk(() => Date.now() + 16 * 60_000);
    expect((await req(later, "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } })).status).toBe(200);
  });

  it("refresh：帶 cookie 換新 access token；沒有 cookie → 401；logout 清 cookie", async () => {
    const s = await seedStore();
    const app = mk();
    const { cookie } = await login(s, app);
    const r = await req(app, "/api/store/auth/refresh", { method: "POST", cookie });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).accessToken).toBeTruthy();
    expect((await req(app, "/api/store/auth/refresh", { method: "POST" })).status).toBe(401);
    const out = await req(app, "/api/store/auth/logout", { method: "POST", cookie });
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("access token 過期（> 15 分鐘）→ 401；人員 token 不能打門店後台 API", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    expect((await req(mk(() => Date.now() + 16 * 60_000), "/api/store/me", { token })).status).toBe(401);
    const staff: any = await (await req(mk(), "/api/staff/login", { token: s.staffDeviceToken, body: { userId: s.staffUserId, pin: s.pin } })).json();
    expect((await req(mk(), "/api/store/me", { token: staff.token })).status).toBe(401);
  });

  it("門店停用 → 登入與既有 token 都 403 STORE_SUSPENDED；到期 → 403 STORE_EXPIRED", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    await req(mk(), `/api/admin/stores/${s.storeId}/suspend`, { method: "POST" });
    expect(((await (await req(mk(), "/api/store/me", { token })).json()) as any).code).toBe("STORE_SUSPENDED");
    const lr = await req(mk(), "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } });
    expect(lr.status).toBe(403);
    expect(((await lr.json()) as any).code).toBe("STORE_SUSPENDED");

    const e = await seedStore({ expiresAt: Date.now() + 5 * 60_000 });
    const t2 = (await login(e)).token;
    // 10 分鐘後：門店已到期，access token（15 分鐘）仍有效 → 403 STORE_EXPIRED（不需排程，每次請求比對）
    const r = await req(mk(() => Date.now() + 10 * 60_000), "/api/store/me", { token: t2 });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).code).toBe("STORE_EXPIRED");
  });

  it("GET /api/store/me：門店資訊、上限、營業時間", async () => {
    const s = await seedStore({ maxStaff: 7 });
    const { token } = await login(s);
    const b: any = await (await req(mk(), "/api/store/me", { token })).json();
    expect(b.store).toMatchObject({ id: s.storeId, name: "測試店", timezone: "Asia/Taipei", businessHours: [] });
    expect(b.limits).toMatchObject({ maxStaff: 7, maxDevices: 2 });
    expect(b.user.displayName).toBe("店長");
  });
});

describe("3.1 服務類別／櫃台／人員／營業時間 CRUD（皆寫稽核）", () => {
  it("服務類別：新增、修改、停用、刪除；字首重複 409、格式錯 422", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    const c = await req(app, "/api/store/services", { token, body: { name: "繳費", prefix: "C", sortOrder: 3, dailyLimit: 50 } });
    expect(c.status).toBe(200);
    const svc: any = ((await c.json()) as any).service;
    expect(svc).toMatchObject({ name: "繳費", prefix: "C", enabled: true, dailyLimit: 50 });
    expect((await req(app, "/api/store/services", { token, body: { name: "重複", prefix: "C" } })).status).toBe(409);
    expect((await req(app, "/api/store/services", { token, body: { name: "", prefix: "D" } })).status).toBe(422);
    expect((await req(app, "/api/store/services", { token, body: { name: "x", prefix: "d1" } })).status).toBe(422);
    expect((await req(app, `/api/store/services/${svc.id}`, { method: "PUT", token, body: { name: "繳費服務", prefix: "C", enabled: false, dailyLimit: null } })).status).toBe(200);
    let list: any = await (await req(app, "/api/store/services", { token })).json();
    expect(list.services.find((x: any) => x.id === svc.id)).toMatchObject({ name: "繳費服務", enabled: false, dailyLimit: null });
    expect((await req(app, `/api/store/services/${svc.id}`, { method: "DELETE", token })).status).toBe(200);
    list = await (await req(app, "/api/store/services", { token })).json();
    expect(list.services.some((x: any) => x.id === svc.id)).toBe(false);
    expect(await audits(s.storeId)).toEqual(expect.arrayContaining(["service.create", "service.update", "service.delete"]));
  });

  it("停用的服務類別不出現在顧客取號頁；每日上限到了 → 409 DAILY_LIMIT", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    await req(app, `/api/store/services/${s.storeId}_B`, { method: "PUT", token, body: { name: "外帶", prefix: "B", enabled: false } });
    await req(app, `/api/store/services/${s.storeId}_A`, { method: "PUT", token, body: { name: "內用", prefix: "A", dailyLimit: 1 } });
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    const w = qrWindow(Date.now());
    const qs = `w=${w}&k=${await computeQrToken(key, s.storeId, w)}`;
    const sess: any = await (await req(app, `/api/s/${s.code}/session?${qs}`)).json();
    expect(sess.services.map((x: any) => x.prefix)).toEqual(["A"]);
    const take = async (phone: string) => {
      const ss: any = await (await req(app, `/api/s/${s.code}/session?${qs}`)).json();
      return req(app, `/api/s/${s.code}/tickets`, { body: { session: ss.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone, consent: true } });
    };
    expect((await take("0911000001")).status).toBe(200);
    const r = await take("0911000002");
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).code).toBe("DAILY_LIMIT");
  });

  it("櫃台：新增（號碼唯一）、修改可服務類別、刪除", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    const r = await req(app, "/api/store/counters", { token, body: { name: "5 號櫃台", number: 5, serviceIds: [`${s.storeId}_A`] } });
    expect(r.status).toBe(200);
    const ct: any = ((await r.json()) as any).counter;
    expect((await req(app, "/api/store/counters", { token, body: { name: "又是 5", number: 5, serviceIds: [] } })).status).toBe(409);
    expect((await req(app, "/api/store/counters", { token, body: { name: "x", number: 0, serviceIds: [] } })).status).toBe(422);
    expect((await req(app, "/api/store/counters", { token, body: { name: "x", number: 6, serviceIds: ["not_mine"] } })).status).toBe(422);
    expect((await req(app, `/api/store/counters/${ct.id}`, { method: "PUT", token, body: { name: "5 號窗口", number: 5, serviceIds: [] } })).status).toBe(200);
    const list: any = await (await req(app, "/api/store/counters", { token })).json();
    expect(list.counters.find((x: any) => x.id === ct.id)).toMatchObject({ name: "5 號窗口", serviceIds: [] });
    expect((await req(app, `/api/store/counters/${ct.id}`, { method: "DELETE", token })).status).toBe(200);
    expect(await audits(s.storeId)).toEqual(expect.arrayContaining(["counter.create", "counter.update", "counter.delete"]));
  });

  it("人員：新增回傳 6 位 PIN（可登入）；超過 max_staff → 409；重設 PIN 讓舊登入失效；停用後不能登入", async () => {
    const s = await seedStore({ maxStaff: 2 });
    const { token } = await login(s);
    const app = mk();
    const r = await req(app, "/api/store/staff", { token, body: { displayName: "林店員" } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.pin).toMatch(/^\d{6}$/);
    expect((await req(app, "/api/store/staff", { token, body: { displayName: "第三位" } })).status).toBe(409);
    const st = async (pin: string) => req(app, "/api/staff/login", { token: s.staffDeviceToken, body: { userId: b.staff.id, pin } });
    const first: any = await (await st(b.pin)).json();
    expect(first.token).toBeTruthy();
    const rp: any = await (await req(app, `/api/store/staff/${b.staff.id}/reset-pin`, { method: "POST", token })).json();
    expect(rp.pin).toMatch(/^\d{6}$/);
    expect((await st(b.pin)).status).toBe(401);
    expect((await st(rp.pin)).status).toBe(200);
    // 舊 token（token_version 已 +1）連 WS 被拒
    const ws = await app.request(`/ws/store/${s.storeId}?role=staff`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${first.token}` } }, env);
    expect(ws.status).toBe(401);
    expect((await req(app, `/api/store/staff/${b.staff.id}/disable`, { method: "POST", token })).status).toBe(200);
    expect((await st(rp.pin)).status).toBe(401);
    expect((await req(app, `/api/store/staff/${b.staff.id}/enable`, { method: "POST", token })).status).toBe(200);
    expect(await audits(s.storeId)).toEqual(expect.arrayContaining(["user.create", "user.reset_pin", "user.disable", "user.enable"]));
    const list: any = await (await req(app, "/api/store/staff", { token })).json();
    expect(JSON.stringify(list)).not.toContain("pin_hash");
  });

  it("營業時間：HH:MM、開店早於打烊、星期 0～6；錯誤 → 422", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    const hours = [{ dow: 1, open: "09:00", close: "21:00" }, { dow: 2, open: "09:00", close: "12:00" }, { dow: 2, open: "13:00", close: "21:00" }];
    expect((await req(app, "/api/store/hours", { method: "PUT", token, body: { businessHours: hours } })).status).toBe(200);
    expect(((await (await req(app, "/api/store/me", { token })).json()) as any).store.businessHours).toEqual(hours);
    for (const bad of [[{ dow: 7, open: "09:00", close: "10:00" }], [{ dow: 1, open: "9:00", close: "10:00" }], [{ dow: 1, open: "10:00", close: "09:00" }]]) {
      expect((await req(app, "/api/store/hours", { method: "PUT", token, body: { businessHours: bad } })).status).toBe(422);
    }
    expect(await audits(s.storeId)).toContain("store.hours");
  });
});

describe("3.3 叫號語音設定：儲存正規化、面板即時套用（settings.changed → 新 hello）", () => {
  it("儲存後 DO 廣播 settings.changed；重連的 hello 帶新設定；interjection 欄位被丟棄", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    // 面板先連上（以 Worker 的 ctx 建立 DO 設定）
    const d = await app.request(`/ws/store/${s.storeId}?role=display`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${s.displayToken}` } }, env);
    const ws = d.webSocket!;
    ws.accept();
    const got: any[] = [];
    ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
    await new Promise((r) => setTimeout(r, 50));
    const r = await req(app, "/api/store/settings/voice", {
      method: "PUT",
      token,
      body: { voiceSettings: { mode: "standard", chime: "chime.bell", repeat: 9, funPrefixProb: 0.5, interjection: { enabled: true, every: 2 } } },
    });
    expect(r.status).toBe(200);
    const saved: any = ((await r.json()) as any).voiceSettings;
    expect(saved).toMatchObject({ mode: "standard", chime: "chime.bell", repeat: 3, funPrefixProb: 0.5 });
    expect(saved.interjection).toBeUndefined();
    await new Promise((r2) => setTimeout(r2, 50));
    expect(got.some((m) => m.type === "settings.changed")).toBe(true);
    ws.close();
    const d2 = await app.request(`/ws/store/${s.storeId}?role=display`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${s.displayToken}` } }, env);
    const ws2 = d2.webSocket!;
    ws2.accept();
    const hello = await new Promise<any>((res) => ws2.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.type === "hello") res(m); }));
    expect(hello.data.store.voiceSettings).toMatchObject({ mode: "standard", chime: "chime.bell" });
    ws2.close();
    expect(await audits(s.storeId)).toContain("store.voice");
  });

  it("DO 不會被舊版本的門店設定覆蓋（多個 isolate 快取不同步時）", async () => {
    const id = `st_ver_${Date.now()}`;
    const newer = { ...storeCtx(id, { name: "新名稱" }), v: 200 };
    const older = { ...storeCtx(id, { name: "舊名稱" }), v: 100 };
    const s1 = await openWs(id, { role: "display", deviceId: "d1" }, { ctx: newer as any });
    expect((await s1.next(isType("hello"))).data.store.name).toBe("新名稱");
    const s2 = await openWs(id, { role: "display", deviceId: "d1" }, { ctx: older as any });
    expect((await s2.next(isType("hello"))).data.store.name).toBe("新名稱");
    s1.ws.close();
    s2.ws.close();
  });

  it("一般設定：面板顯示遮罩姓名、前面剩幾位提醒（1～5）；QR 金鑰重設後舊 QR 失效", async () => {
    const s = await seedStore();
    const { token } = await login(s);
    const app = mk();
    expect((await req(app, "/api/store/settings/general", { method: "PUT", token, body: { showMaskedName: true, notifyAhead: 9 } })).status).toBe(422);
    expect((await req(app, "/api/store/settings/general", { method: "PUT", token, body: { showMaskedName: true, notifyAhead: 2 } })).status).toBe(200);
    const me: any = await (await req(app, "/api/store/me", { token })).json();
    expect(me.store.features.showMaskedName).toBe(true);
    expect(me.store.notifyAhead).toBe(2);
    const key1 = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    const w = qrWindow(Date.now());
    const qs1 = `w=${w}&k=${await computeQrToken(key1, s.storeId, w)}`;
    expect((await req(app, `/api/s/${s.code}/session?${qs1}`)).status).toBe(200);
    expect((await req(app, "/api/store/qr/rotate", { method: "POST", token })).status).toBe(200);
    expect((await req(app, `/api/s/${s.code}/session?${qs1}`)).status).toBe(401);
    const key2 = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 2);
    expect((await req(app, `/api/s/${s.code}/session?w=${w}&k=${await computeQrToken(key2, s.storeId, w)}`)).status).toBe(200);
    expect(await audits(s.storeId)).toEqual(expect.arrayContaining(["store.settings", "qr.rotate"]));
  });
});

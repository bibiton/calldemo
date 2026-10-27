import { describe, expect, it } from "vitest";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { seedStore, type Seeded } from "./fixtures";

const app = createApp();
const later = (ms: number) => createApp({ now: () => Date.now() + ms });

function req(a: ReturnType<typeof createApp>, path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return a.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }, env);
}
async function adminToken(s: Seeded) {
  return ((await (await req(app, "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } })).json()) as any).accessToken as string;
}
async function start(kind: "display" | "staff") {
  const r = await req(app, `/api/${kind}/pair/start`, { method: "POST" });
  expect(r.status).toBe(200);
  return (await r.json()) as { code: string; pollSecret: string; expiresAt: number };
}
const status = (kind: "display" | "staff", p: { code: string; pollSecret: string }, a = app) =>
  req(a, `/api/${kind}/pair/status?code=${p.code}&secret=${encodeURIComponent(p.pollSecret)}`);
const wsOpen = (storeId: string, role: string, token: string) =>
  app.request(`/ws/store/${storeId}?role=${role}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${token}` } }, env);

describe("3.2 面板配對（配對碼由面板顯示，店長在手機輸入；面板端只需遙控器）", () => {
  it("面板取得 6 位配對碼 → 等待中 → 店長輸入 → 面板輪詢拿到 device token（只能領一次）", async () => {
    const s = await seedStore();
    const t = await adminToken(s);
    const p = await start("display");
    expect(p.code).toMatch(/^\d{6}$/);
    expect(p.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(((await (await status("display", p)).json()) as any).status).toBe("pending");
    const r = await req(app, "/api/store/devices/pair", { token: t, body: { code: p.code, name: "門口面板" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).device).toMatchObject({ kind: "display", name: "門口面板", status: "active" });
    const got: any = await (await status("display", p)).json();
    expect(got.status).toBe("paired");
    expect(got.storeId).toBe(s.storeId);
    const ws = await wsOpen(s.storeId, "display", got.token);
    expect(ws.status).toBe(101);
    ws.webSocket!.accept();
    ws.webSocket!.close();
    expect((await status("display", p)).status).toBe(404);
    const list: any = await (await req(app, "/api/store/devices", { token: t })).json();
    expect(list.devices.filter((d: any) => d.kind === "display" && d.status === "active")).toHaveLength(2);
    expect(list.maxDevices).toBe(2);
  });

  it("輪詢密鑰錯 → 404；配對碼過期（> 10 分鐘）→ 店長輸入 404；格式錯 → 422", async () => {
    const s = await seedStore();
    const t = await adminToken(s);
    const p = await start("display");
    expect((await status("display", { code: p.code, pollSecret: "wrong" })).status).toBe(404);
    const lt = later(11 * 60_000);
    const tok = ((await (await req(lt, "/api/store/auth/login", { body: { email: s.adminEmail, password: s.adminPassword } })).json()) as any).accessToken;
    expect((await req(lt, "/api/store/devices/pair", { token: tok, body: { code: p.code, name: "x" } })).status).toBe(404);
    expect((await req(app, "/api/store/devices/pair", { token: t, body: { code: "12ab", name: "x" } })).status).toBe(422);
  });

  it("超過 max_devices（active 面板數）→ 409 DEVICE_LIMIT", async () => {
    const s = await seedStore({ maxDevices: 2 }); // 已有 1 台
    const t = await adminToken(s);
    expect((await req(app, "/api/store/devices/pair", { token: t, body: { code: (await start("display")).code, name: "2" } })).status).toBe(200);
    const r = await req(app, "/api/store/devices/pair", { token: t, body: { code: (await start("display")).code, name: "3" } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any)).toMatchObject({ code: "DEVICE_LIMIT", max: 2 });
  });

  it("解除配對：已連線的面板立即被斷線（4001），之後 token 失效（401）；寫稽核", async () => {
    const s = await seedStore();
    const t = await adminToken(s);
    const ws = await wsOpen(s.storeId, "display", s.displayToken);
    expect(ws.status).toBe(101);
    const sock = ws.webSocket!;
    sock.accept();
    const closed = new Promise<number>((r) => sock.addEventListener("close", (e) => r(e.code)));
    expect((await req(app, `/api/store/devices/${s.storeId}_d1/revoke`, { method: "POST", token: t })).status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await wsOpen(s.storeId, "display", s.displayToken)).status).toBe(401);
    expect((await req(app, "/api/display/ads/manifest", { token: s.displayToken })).status).toBe(401);
    const a = (await env.DB.prepare("SELECT action FROM audit_logs WHERE store_id=? AND action LIKE 'device.%'").bind(s.storeId).all()).results.map((r: any) => r.action);
    expect(a).toContain("device.revoke");
  });

  it("人員手機配對與解除：解除後該手機不能再登入人員", async () => {
    const s = await seedStore();
    const t = await adminToken(s);
    const p = await start("staff");
    expect((await req(app, "/api/store/devices/pair", { token: t, body: { code: p.code, name: "櫃台 2 手機" } })).status).toBe(200);
    const got: any = await (await status("staff", p)).json();
    const dev: any = await (await req(app, "/api/staff/device", { token: got.token })).json();
    expect(dev.store.id).toBe(s.storeId);
    const login = await req(app, "/api/staff/login", { token: got.token, body: { userId: s.staffUserId, pin: s.pin } });
    expect(login.status).toBe(200);
    const list: any = await (await req(app, "/api/store/devices", { token: t })).json();
    const d = list.devices.find((x: any) => x.name === "櫃台 2 手機");
    expect((await req(app, `/api/store/devices/${d.id}/revoke`, { method: "POST", token: t })).status).toBe(200);
    expect((await req(app, "/api/staff/login", { token: got.token, body: { userId: s.staffUserId, pin: s.pin } })).status).toBe(401);
  });

  it("面板配對碼不能被人員裝置流程領走（kind 不同）", async () => {
    const p = await start("display");
    expect((await status("staff", p)).status).toBe(404);
  });
});

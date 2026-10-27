import { describe, expect, it } from "vitest";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { computeQrToken, deriveStoreKey, qrWindow } from "@qcs/shared";
import { seedStore } from "./fixtures";
import { isType } from "./helpers";

const T0 = Date.UTC(2026, 9, 27, 4, 0); // 台北 12:00

function appAt(now = T0) {
  const app = createApp({ now: () => now });
  return {
    fetch: (path: string, init: RequestInit = {}) => app.request(path, init, env),
  };
}

async function qrParams(storeId: string, w: number) {
  const key = await deriveStoreKey(env.QR_ROOT_SECRET, storeId, 1);
  return `w=${w}&k=${await computeQrToken(key, storeId, w)}`;
}

async function session(s: { storeId: string; code: string }, now = T0) {
  const res = await appAt(now).fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, qrWindow(now))}`);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("health", () => {
  it("GET /health → 200", async () => {
    const res = await appAt().fetch("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("T7 動態 QR", () => {
  it("window 與 window-1 通過；window-2 → 401 QR_EXPIRED；錯 token → 401 QR_INVALID", async () => {
    const s = await seedStore();
    const w = qrWindow(T0);
    const a = appAt();
    expect((await a.fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, w)}`)).status).toBe(200);
    expect((await a.fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, w - 1)}`)).status).toBe(200);
    const old = await a.fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, w - 2)}`);
    expect(old.status).toBe(401);
    expect(await old.json()).toMatchObject({ code: "QR_EXPIRED" });
    const bad = await a.fetch(`/api/s/${s.code}/session?w=${w}&k=AAAAAAAAAA`);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: "QR_INVALID" });
  });
  it("session 回應含門店名稱、服務與等候數", async () => {
    const s = await seedStore();
    const body = await session(s);
    expect(body.store.name).toBe("測試店");
    expect(body.services.map((x: any) => x.prefix)).toEqual(["A", "B"]);
    expect(body.services[0].waiting).toBe(0);
    expect(typeof body.sessionToken).toBe("string");
  });
  it("不存在的門店碼 → 404", async () => {
    expect((await appAt().fetch(`/api/s/NOPE99/session?w=1&k=AAAAAAAAAA`)).status).toBe(404);
  });
});

describe("取號 API", () => {
  it("取號成功回 ticket＋ticketToken", async () => {
    const s = await seedStore();
    const sess = await session(s);
    const res = await appAt().fetch(
      `/api/s/${s.code}/tickets`,
      json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone: "0912-345-678", consent: true }),
    );
    expect(res.status).toBe(200);
    const b: any = await res.json();
    expect(b.ticket.number).toBe("A001");
    expect(typeof b.ticketToken).toBe("string");
  });
  it("T10：手機格式錯 → 422", async () => {
    const s = await seedStore();
    const sess = await session(s);
    const res = await appAt().fetch(
      `/api/s/${s.code}/tickets`,
      json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone: "0812345678", consent: true }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "PHONE_INVALID" });
  });
  it("未勾個資同意 → 422 CONSENT_REQUIRED", async () => {
    const s = await seedStore();
    const sess = await session(s);
    const res = await appAt().fetch(
      `/api/s/${s.code}/tickets`,
      json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone: "0912345678", consent: false }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
  });
  it("T8：同 session 取兩次（不同人）→ 409", async () => {
    const s = await seedStore();
    const sess = await session(s);
    const body = (phone: string, name: string) =>
      json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name, phone, consent: true });
    expect((await appAt().fetch(`/api/s/${s.code}/tickets`, body("0912345678", "甲"))).status).toBe(200);
    const r2 = await appAt().fetch(`/api/s/${s.code}/tickets`, body("0922345678", "乙"));
    expect(r2.status).toBe(409);
    expect(await r2.json()).toMatchObject({ code: "SESSION_USED" });
  });
  it("T9：同手機同姓名（新 session）回原號碼；不同姓名 409", async () => {
    const s = await seedStore();
    const take = async (name: string) => {
      const sess = await session(s);
      return appAt().fetch(
        `/api/s/${s.code}/tickets`,
        json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name, phone: "+886912345678", consent: true }),
      );
    };
    const a: any = await (await take("王小明")).json();
    const b: any = await (await take("王小明")).json();
    expect(b.existing).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
    const c = await take("李大華");
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ code: "PHONE_ACTIVE" });
  });
  it("session 過期（> 10 分鐘）→ 401", async () => {
    const s = await seedStore();
    const sess = await session(s);
    const res = await appAt(T0 + 11 * 60_000).fetch(
      `/api/s/${s.code}/tickets`,
      json({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王", phone: "0912345678", consent: true }),
    );
    expect(res.status).toBe(401);
  });
  it("顧客可用 ticketToken 取消自己的號碼；別人的 token 不行", async () => {
    const s = await seedStore();
    const t1: any = await (await appAt().fetch(`/api/s/${s.code}/tickets`, json({ session: (await session(s)).sessionToken, serviceId: `${s.storeId}_A`, name: "甲", phone: "0912000001", consent: true }))).json();
    const t2: any = await (await appAt().fetch(`/api/s/${s.code}/tickets`, json({ session: (await session(s)).sessionToken, serviceId: `${s.storeId}_A`, name: "乙", phone: "0912000002", consent: true }))).json();
    const wrong = await appAt().fetch(`/api/tickets/${t1.ticket.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${t2.ticketToken}` } });
    expect(wrong.status).toBe(403);
    const ok = await appAt().fetch(`/api/tickets/${t1.ticket.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${t1.ticketToken}` } });
    expect(ok.status).toBe(200);
    const me = await appAt().fetch(`/api/tickets/me`, { headers: { authorization: `Bearer ${t1.ticketToken}` } });
    expect(((await me.json()) as any).ticket.status).toBe("cancelled");
  });
});

describe("T3 門店停用", () => {
  it("停用 API → 之後 API 回 403 STORE_SUSPENDED；已連線 WS 收到 store.suspended 並 4003 關閉", async () => {
    const s = await seedStore();
    const app = createApp({ now: () => Date.now() });
    const ws = await openViaWorker(app, s.storeId, "display", s.displayToken);
    await waitFor(ws, "snapshot");
    const sus = await app.request(`/api/admin/stores/${s.storeId}/suspend`, { method: "POST", headers: { "x-qcs-admin": "1" } }, env);
    expect(sus.status).toBe(200);
    expect((await waitFor(ws, "store.suspended")).data.reason).toBe("suspended");
    expect(await ws.closed).toBe(4003);
    const w = qrWindow(Date.now());
    const res = await app.request(`/api/s/${s.code}/session?${await qrParams(s.storeId, w)}`, {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "STORE_SUSPENDED" });
    const wsRes = await app.request(`/ws/store/${s.storeId}?role=display`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${s.displayToken}` } }, env);
    expect(wsRes.status).toBe(403);
    // 恢復
    expect((await app.request(`/api/admin/stores/${s.storeId}/resume`, { method: "POST", headers: { "x-qcs-admin": "1" } }, env)).status).toBe(200);
    expect((await app.request(`/api/s/${s.code}/session?${await qrParams(s.storeId, w)}`, {}, env)).status).toBe(200);
  });
  it("非 local 環境沒有 Access 驗證時 /api/admin 一律 401", async () => {
    const s = await seedStore();
    const res = await createApp().request(`/api/admin/stores/${s.storeId}/suspend`, { method: "POST" }, { ...env, ENV: "staging" });
    expect(res.status).toBe(401);
  });
  it("production 帶 DEV_BYPASS_ACCESS → 拒絕服務", async () => {
    const res = await createApp().request(`/health`, {}, { ...env, ENV: "production", DEV_BYPASS_ACCESS: "1" });
    expect(res.status).toBe(500);
  });
});

describe("T4 到期", () => {
  it("注入 clock 超過 expires_at → 403 STORE_EXPIRED，無需排程", async () => {
    const s = await seedStore({ expiresAt: T0 + 3600_000 });
    const before = await appAt(T0).fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, qrWindow(T0))}`);
    expect(before.status).toBe(200);
    const later = T0 + 2 * 3600_000;
    const after = await appAt(later).fetch(`/api/s/${s.code}/session?${await qrParams(s.storeId, qrWindow(later))}`);
    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ code: "STORE_EXPIRED" });
  });
});

describe("人員登入（ADR-004）", () => {
  it("已綁定裝置＋正確 PIN → staff token；錯 PIN → 401；連錯 5 次鎖定", async () => {
    const s = await seedStore();
    const a = appAt();
    const auth = { authorization: `Bearer ${s.staffDeviceToken}` };
    const dev = await a.fetch(`/api/staff/device`, { headers: auth });
    expect(dev.status).toBe(200);
    expect(((await dev.json()) as any).staff[0]).toMatchObject({ id: s.staffUserId, displayName: "王店員" });
    const good = await a.fetch(`/api/staff/login`, json({ userId: s.staffUserId, pin: "123456" }, auth));
    expect(good.status).toBe(200);
    expect(typeof ((await good.json()) as any).token).toBe("string");
    for (let i = 0; i < 5; i++) expect((await a.fetch(`/api/staff/login`, json({ userId: s.staffUserId, pin: "000000" }, auth))).status).toBe(401);
    const locked = await a.fetch(`/api/staff/login`, json({ userId: s.staffUserId, pin: "123456" }, auth));
    expect(locked.status).toBe(423);
  });
  it("沒有裝置 token 不能嘗試 PIN", async () => {
    const s = await seedStore();
    expect((await appAt().fetch(`/api/staff/login`, json({ userId: s.staffUserId, pin: "123456" }))).status).toBe(401);
  });
  it("面板 token 不能當人員裝置 token", async () => {
    const s = await seedStore();
    const r = await appAt().fetch(`/api/staff/login`, json({ userId: s.staffUserId, pin: "123456" }, { authorization: `Bearer ${s.displayToken}` }));
    expect(r.status).toBe(401);
  });
  it("裝置被撤銷（revoked）後 token 失效", async () => {
    const s = await seedStore();
    await env.DB.prepare("UPDATE devices SET status='revoked' WHERE id=?").bind(`${s.storeId}_sd1`).run();
    expect((await appAt().fetch(`/api/staff/device`, { headers: { authorization: `Bearer ${s.staffDeviceToken}` } })).status).toBe(401);
  });
});

describe("WS upgrade 轉交", () => {
  it("token 走 Sec-WebSocket-Protocol，回傳 qcs.v1；無 token → 401", async () => {
    const s = await seedStore();
    const app = createApp();
    const no = await app.request(`/ws/store/${s.storeId}?role=display`, { headers: { Upgrade: "websocket" } }, env);
    expect(no.status).toBe(401);
    const ws = await openViaWorker(app, s.storeId, "display", s.displayToken);
    const hello = await waitFor(ws, "hello");
    expect(hello.data.qr.keyVersion).toBe(1);
    expect(ws.protocol).toBe("qcs.v1");
    ws.ws.close();
  });
  it("token 的門店與路徑不符 → 403", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const res = await createApp().request(`/ws/store/${b.storeId}?role=display`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${a.displayToken}` } }, env);
    expect(res.status).toBe(403);
  });
  it("staff 以登入後 token 連線並可叫號", async () => {
    const s = await seedStore();
    const app = createApp();
    const login: any = await (
      await app.request(`/api/staff/login`, json({ userId: s.staffUserId, pin: "123456" }, { authorization: `Bearer ${s.staffDeviceToken}` }), env)
    ).json();
    const ws = await openViaWorker(app, s.storeId, "staff", login.token);
    await waitFor(ws, "snapshot");
    ws.ws.send(JSON.stringify({ t: "cmd", cmdId: "x1", cmd: "createTicket", args: { serviceId: `${s.storeId}_A` } }));
    const ack = await waitFor(ws, (m: any) => m.t === "ack");
    expect(ack.ok).toBe(true);
    ws.ws.close();
  });
});

describe("面板廣告 manifest", () => {
  it("回傳啟用中的項目與版本；需 display token", async () => {
    const s = await seedStore();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ad_assets(id,owner_type,owner_id,kind,r2_key,sha256,mime,bytes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(`${s.storeId}_ad1`, "store", s.storeId, "image", "demo-ads/ad1.svg", "x", "image/svg+xml", 100, "ready", now),
      env.DB.prepare("INSERT INTO ad_playlists(id,owner_type,owner_id,version,updated_at) VALUES(?,?,?,?,?)").bind(`${s.storeId}_pl`, "store", s.storeId, 3, now),
      env.DB.prepare("INSERT INTO ad_playlist_items(id,playlist_id,asset_id,sort_order,duration_ms) VALUES(?,?,?,?,?)").bind(`${s.storeId}_it1`, `${s.storeId}_pl`, `${s.storeId}_ad1`, 1, 8000),
    ]);
    expect((await createApp().request(`/api/display/ads/manifest`, {}, env)).status).toBe(401);
    const res = await createApp().request(`/api/display/ads/manifest`, { headers: { authorization: `Bearer ${s.displayToken}` } }, env);
    const b: any = await res.json();
    expect(b.version).toBe(3);
    expect(b.items[0]).toMatchObject({ kind: "image", durationMs: 8000, url: "http://localhost:5174/demo-ads/ad1.svg" });
  });
});

// ---- helpers ----
async function openViaWorker(app: ReturnType<typeof createApp>, storeId: string, role: string, token: string) {
  const res = await app.request(
    `/ws/store/${storeId}?role=${role}`,
    { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${token}` } },
    env,
  );
  if (res.status !== 101) throw new Error(`ws ${res.status} ${await res.text()}`);
  const ws = res.webSocket!;
  ws.accept();
  const msgs: any[] = [];
  let onMsg: (() => void) | null = null;
  let closeR!: (c: number) => void;
  const closed = new Promise<number>((r) => (closeR = r));
  ws.addEventListener("message", (e) => {
    try {
      msgs.push(JSON.parse(String(e.data)));
    } catch {
      msgs.push(String(e.data));
    }
    onMsg?.();
  });
  ws.addEventListener("close", (e) => closeR(e.code));
  return { ws, msgs, closed, protocol: res.headers.get("Sec-WebSocket-Protocol"), wake: (f: () => void) => (onMsg = f) };
}

async function waitFor(s: Awaited<ReturnType<typeof openViaWorker>>, p: string | ((m: any) => boolean), ms = 3000) {
  const pred = typeof p === "string" ? isType(p) : p;
  const t0 = Date.now();
  for (;;) {
    const i = s.msgs.findIndex(pred);
    if (i >= 0) return s.msgs.splice(i, 1)[0];
    if (Date.now() - t0 > ms) throw new Error("timeout; got " + JSON.stringify(s.msgs).slice(0, 500));
    await new Promise((r) => setTimeout(r, 10));
  }
}

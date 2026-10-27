/**
 * M5 上線前：5.2 個資（D1 全表掃描無姓名／手機原文、關店後 DO 原文清空）、5.3 安全（CORS 白名單、
 * 每店 PIN 失敗限流 06 §1、錯誤訊息不洩漏內部資訊）。
 */
import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { computeQrToken, deriveStoreKey, qrWindow } from "@qcs/shared";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { writeHistory } from "../src/queue-consumer";
import { seedStore } from "./fixtures";
import { isType, openWs, staffCmd, storeCtx, stubFor } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";

const T0 = Date.UTC(2054, 9, 27, 4, 0); // 台北 12:00

describe("部署驗證：/health 回報部署版本", () => {
  it("有 VERSION（deploy.sh 帶入 git sha）就回它；本機回預設版本", async () => {
    const a = createApp();
    const e = Object.create(env as object);
    Object.defineProperty(e, "VERSION", { value: "abc1234" });
    expect(await (await a.request("/health", {}, e)).json()).toMatchObject({ ok: true, version: "abc1234" });
    expect(((await (await a.request("/health", {}, env)).json()) as any).version).toBe("0.1.0");
  });
});

describe("5.3 CORS 白名單", () => {
  const app = createApp({ now: () => T0 });
  it("白名單內的來源 → 回 Access-Control-Allow-Origin；名單外 → 不回（瀏覽器擋下）", async () => {
    const ok = await app.request("/api/staff/me", { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET" } }, env);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const bad = await app.request("/api/staff/me", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } }, env);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const get = await app.request("/health", { headers: { Origin: "https://evil.example" } }, env);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("未預期錯誤只回代碼 INTERNAL，不帶堆疊或訊息", async () => {
    const a = createApp({ now: () => T0 });
    const broken = Object.create(env as object);
    Object.defineProperty(broken, "DB", { value: { prepare: () => { throw new Error("secret-internal-detail"); }, batch: () => { throw new Error("secret-internal-detail"); } } });
    const res = await a.request("/api/staff/device", { headers: { authorization: "Bearer x.y.z" } }, broken);
    const body = await res.text();
    expect(body).not.toContain("secret-internal-detail");
  });
});

describe("5.3 每店 PIN 失敗限流（06 §1：每店每分鐘 > 20 次 → 暫停 5 分鐘）", () => {
  it("同店 21 次錯誤 PIN（分散在不同人員，不觸發個人鎖定）→ 該店 PIN 登入 429 PIN_PAUSED 5 分鐘；別店不受影響；5 分鐘後恢復", async () => {
    const s = await seedStore();
    const other = await seedStore();
    // 多建幾位人員：每人只錯 4 次，不會觸發個人 5 次鎖定
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `${s.storeId}_px${i}`;
      ids.push(id);
      await env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,pin_hash,created_at,updated_at) SELECT ?, 'staff', store_id, ?, pin_hash, created_at, updated_at FROM users WHERE id=?").bind(id, `人員${i}`, s.staffUserId).run();
    }
    let t = T0;
    const app = createApp({ now: () => t });
    const login = (sid: string, dev: string, userId: string, pin: string) =>
      app.request("/api/staff/login", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dev}` }, body: JSON.stringify({ userId, pin }) }, env);
    let n = 0;
    for (const id of ids) {
      for (let k = 0; k < 4 && n < 21; k++, n++) expect((await login(s.storeId, s.staffDeviceToken, id, "000000")).status).toBe(401);
    }
    expect(n).toBe(21);
    const paused = await login(s.storeId, s.staffDeviceToken, s.staffUserId, s.pin); // 正確 PIN 也暫停
    expect(paused.status).toBe(429);
    expect(await paused.json()).toMatchObject({ code: "PIN_PAUSED" });
    expect((await login(other.storeId, other.staffDeviceToken, other.staffUserId, other.pin)).status).toBe(200);
    t = T0 + 4 * 60_000;
    expect((await login(s.storeId, s.staffDeviceToken, s.staffUserId, s.pin)).status).toBe(429);
    t = T0 + 6 * 60_000;
    expect((await login(s.storeId, s.staffDeviceToken, s.staffUserId, s.pin)).status).toBe(200);
    const aud = await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE store_id=? AND action='store.pin_paused'").bind(s.storeId).first<{ n: number }>();
    expect(aud!.n).toBe(1);
  });
  it("20 次以內不暫停", async () => {
    const s = await seedStore();
    const app = createApp({ now: () => T0 });
    for (let i = 0; i < 4; i++) {
      await app.request("/api/staff/login", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.staffDeviceToken}` }, body: JSON.stringify({ userId: s.staffUserId, pin: "000000" }) }, env);
    }
    const r = await app.request("/api/staff/login", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.staffDeviceToken}` }, body: JSON.stringify({ userId: s.staffUserId, pin: s.pin }) }, env);
    expect(r.status).toBe(200);
  });
});

describe("5.2 個資：完整流程後 D1 全表沒有姓名／手機原文；關店後 DO 原文清空", () => {
  it("取號（QR）→ 叫號 → 查看完整手機 → 完成；人員代取號；關店 → q-history → D1 每張表每一欄都找不到原文", async () => {
    const s = await seedStore();
    const NAME = "歐陽娜娜";
    const PHONE = "0987654321";
    const PHONE2 = "0911222333";
    const app = createApp({ now: () => T0 });
    await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => i.setClock(() => T0)); // 第一張號碼也用 T0 的營業日
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    const w = qrWindow(T0);
    const sess: any = await (await app.request(`/api/s/${s.code}/session?w=${w}&k=${await computeQrToken(key, s.storeId, w)}`, {}, env)).json();
    const take: any = await (
      await app.request(`/api/s/${s.code}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: NAME, phone: PHONE, consent: true }) }, env)
    ).json();
    expect(take.ticket.number).toBe("A001");
    await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => {
      i.setClock(() => T0 + 60_000);
      i.captureHistory = true;
    });
    const ctx = { ...storeCtx(s.storeId), store: { ...storeCtx(s.storeId).store, services: [{ id: `${s.storeId}_A`, name: "內用", prefix: "A" }], counters: [{ id: `${s.storeId}_c1`, name: "1 號櫃台", number: 1, serviceIds: [] }] } };
    const ws = await openWs(s.storeId, { role: "staff", staffId: s.staffUserId, deviceId: `${s.storeId}_sd1` }, { ctx });
    await ws.next(isType("snapshot"));
    const called = await staffCmd(ws, "callNext", { counterId: `${s.storeId}_c1` });
    expect(called.ok).toBe(true);
    expect((await staffCmd(ws, "revealPhone", { ticketId: called.result.ticket.id })).result.phone).toBe(PHONE);
    await staffCmd(ws, "finish", { ticketId: called.result.ticket.id });
    await staffCmd(ws, "createTicket", { serviceId: `${s.storeId}_A`, name: "林志明", phone: PHONE2 });
    ws.ws.close();
    await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO) => i.setClock(() => T0 + 13 * 3600_000));
    await runDurableObjectAlarm(stubFor(s.storeId));
    const out = await runInDurableObject(stubFor(s.storeId), (i: StoreQueueDO, st) => ({
      sent: i.captured,
      raw: st.storage.sql.exec("SELECT name, phone FROM tickets").toArray(),
    }));
    expect(out.raw.every((r: any) => r.name === null && r.phone === null)).toBe(true);
    for (const m of out.sent) await writeHistory(env, m);
    const hist = await env.DB.prepare("SELECT name_masked, phone_masked, phone_hmac FROM tickets_history WHERE store_id=? ORDER BY number").bind(s.storeId).all<any>();
    expect(hist.results.map((r) => r.name_masked)).toEqual(["歐○○娜", "林○明"]);
    expect(hist.results[0].phone_masked).toBe("0987***321");
    expect(hist.results[0].phone_hmac).toMatch(/^[0-9a-f]{32}$/);
    // 全部 D1 表、全部欄位
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results;
    expect(tables.length).toBeGreaterThan(15);
    for (const { name } of tables) {
      const rows = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
      const dump = JSON.stringify(rows);
      for (const pii of [NAME, PHONE, PHONE2, "林志明", "+886987654321", "987654321"]) expect(dump.includes(pii), `${name} 含 ${pii}`).toBe(false);
    }
  });
});

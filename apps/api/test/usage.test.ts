/**
 * M4 4.3／4.4 計量（12-usage-metering）：T18、DO 小時桶 → usage_hourly、推播計數、Analytics Engine 寫入與匯入、
 * 日／月彙總、估算成本、帳單分攤、異常警示（含人為製造夜間喚醒）、Cron 分派。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMessageBatch, evictDurableObject, getQueueResult, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, envWith } from "./test-env";
import { createApp } from "../src/app";
import { StoreQueueDO } from "../src/do/store-queue";
import { writeHistory } from "../src/queue-consumer";
import { handlePushBatch } from "../src/push-consumer";
import { importAeDay } from "../src/usage/ae";
import { allocate, buildMonth, dailyFromHourly, ensureDaily, monthFromDaily, persistMonth, rollupDay, type MonthRow } from "../src/usage/rollup";
import { isOffHours } from "../src/usage/hours";
import { estDayCost } from "../src/usage/prices";
import { runUsageCron } from "../src/usage/cron";
import { storeAlerts } from "../src/usage/alerts";
import { seedStore } from "./fixtures";
import { isType, openWs, staffCmd, storeCtx, stubFor, take, uniq } from "./helpers";
import { b64urlEncode } from "@qcs/shared";

const H = 3600_000;
const DAY = 86400_000;

afterEach(() => {
  StoreQueueDO.aeSink = null;
});

// ---------- T18 ----------

/** 把 DO 的 sql.exec 換成會累計 cursor.rowsWritten 的版本（SQLite 實際寫入列數，含索引）。 */
async function countRows(storeId: string) {
  await runInDurableObject(stubFor(storeId), (inst: StoreQueueDO) => {
    const raw = (inst as any).sql as SqlStorage;
    const cursors: SqlStorageCursor<any>[] = [];
    (inst as any).__cursors = cursors;
    (inst as any).sql = {
      exec: (q: string, ...a: unknown[]) => {
        const cur = raw.exec(q, ...a);
        cursors.push(cur);
        return cur;
      },
      get databaseSize() {
        return raw.databaseSize;
      },
    };
  });
}
const rowsWritten = (storeId: string) =>
  runInDurableObject(stubFor(storeId), (inst: StoreQueueDO) => ((inst as any).__cursors as SqlStorageCursor<any>[]).reduce((a, c) => a + c.rowsWritten, 0));

async function scenario(storeId: string, metering: boolean) {
  const T = Date.UTC(2026, 9, 27, 4, 0);
  await runInDurableObject(stubFor(storeId), (i: StoreQueueDO) => {
    i.setClock(() => T);
    i.setMetering(metering);
    i.captureHistory = true;
  });
  await countRows(storeId);
  const d = await openWs(storeId, { role: "display", deviceId: "d1" });
  await d.next(isType("snapshot"));
  const s = await openWs(storeId, { role: "staff", staffId: "u1", deviceId: "sd1" });
  await s.next(isType("snapshot"));
  const ts: any[] = [];
  for (let i = 1; i <= 6; i++) ts.push(await take(storeId, i));
  for (let i = 0; i < 3; i++) await staffCmd(s, "callNext", { counterId: "c2" });
  await staffCmd(s, "recall", { ticketId: ts[2].ticket.id });
  await staffCmd(s, "finish", { ticketId: ts[2].ticket.id });
  await stubFor(storeId).cancelTicket(storeCtx(storeId), ts[5].ticket.id);
  await stubFor(storeId).ticketView(storeCtx(storeId), ts[4].ticket.id);
  const alarm = await runInDurableObject(stubFor(storeId), (_i: StoreQueueDO, st) => st.storage.getAlarm());
  await runInDurableObject(stubFor(storeId), (i: StoreQueueDO) => i.setClock(() => T + 13 * H));
  await runDurableObjectAlarm(stubFor(storeId));
  const rows = await rowsWritten(storeId);
  const sent = await runInDurableObject(stubFor(storeId), (i: StoreQueueDO) => i.captured);
  const meta = await runInDurableObject(stubFor(storeId), (_i: StoreQueueDO, st) => st.storage.sql.exec("SELECT key FROM meta ORDER BY key").toArray().map((x: any) => x.key));
  d.ws.close();
  s.ws.close();
  return { rows, alarm, sent, meta };
}

describe("T18 用量計量不增加寫入", () => {
  it("同一情境開／關計量：DO rows written 相同、alarm 相同、meta 列相同；開啟時小時桶隨 q-history 送出", async () => {
    const on = await scenario(uniq("t18on"), true);
    const off = await scenario(uniq("t18off"), false);
    expect(on.rows).toBeGreaterThan(20);
    expect(on.rows).toBe(off.rows);
    expect(on.alarm).toBe(off.alarm);
    expect(on.meta).toEqual(off.meta);
    const usageOn = on.sent.flatMap((m: any) => m.usage);
    const usageOff = off.sent.flatMap((m: any) => m.usage);
    expect(usageOff).toEqual([]);
    const sum = (k: string) => usageOn.reduce((a: number, b: any) => a + (b[k] ?? 0), 0);
    expect(sum("tickets")).toBe(6);
    expect(sum("calls")).toBe(4); // 3 次叫號＋1 次重叫
    expect(sum("wsConn")).toBe(2);
    expect(sum("rpc")).toBeGreaterThanOrEqual(8); // 6 取號＋取消＋查詢
    expect(sum("alarms")).toBe(1);
    expect(sum("events")).toBeGreaterThan(0);
    expect(sum("rowsW")).toBeGreaterThan(0);
    // 送出的訊息數相同（計量資料併入既有批次，不另送）
    expect(on.sent.filter((m: any) => m.rows.length).length).toBe(off.sent.filter((m: any) => m.rows.length).length);
  });

  it("DO 沒有新增任何計時器（只有原本的關店 alarm）", async () => {
    const id = uniq();
    await take(id, 1);
    const a = await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => st.storage.getAlarm());
    expect(a).not.toBeNull(); // 關店 alarm（ADR-009）
    await runInDurableObject(stubFor(id), (i: StoreQueueDO) => i.setMetering(false));
    const id2 = uniq();
    await runInDurableObject(stubFor(id2), (i: StoreQueueDO) => i.setMetering(false));
    await take(id2, 1);
    const b = await runInDurableObject(stubFor(id2), (_i: StoreQueueDO, st) => st.storage.getAlarm());
    expect(typeof b).toBe(typeof a);
  });
});

// ---------- DO 桶 → usage_hourly ----------

describe("q-history consumer：DO 小時桶 → usage_hourly", () => {
  it("同店同小時累加；不同小時分列；不合法的桶略過", async () => {
    const sid = uniq("u");
    const b = (h: string, n: number) => ({ h, wsConn: n, wsIn: 10 * n, rpc: n, alarms: 0, tickets: n, calls: n, events: 2 * n, wakes: n, rowsW: 3 * n });
    await writeHistory(env, { kind: "history", storeId: sid, rows: [], audits: [], usage: [b("2026-10-20T05", 1), b("2026-10-20T06", 2)] });
    await writeHistory(env, { kind: "history", storeId: sid, rows: [], audits: [], usage: [b("2026-10-20T05", 4), { h: "垃圾" } as any] });
    const rows = await env.DB.prepare("SELECT hour_start, ws_connects, ws_messages, tickets, do_rows_written FROM usage_hourly WHERE store_id=? ORDER BY hour_start").bind(sid).all<any>();
    expect(rows.results).toEqual([
      { hour_start: Date.UTC(2026, 9, 20, 5), ws_connects: 5, ws_messages: 50, tickets: 5, do_rows_written: 15 },
      { hour_start: Date.UTC(2026, 9, 20, 6), ws_connects: 2, ws_messages: 20, tickets: 2, do_rows_written: 6 },
    ]);
  });

  it("晚到的桶（該日已彙總）→ 自動重算該店該日", async () => {
    const s = await seedStore();
    const date = "2026-10-21";
    await writeHistory(env, { kind: "history", storeId: s.storeId, rows: [], audits: [], usage: [{ h: `${date}T05`, wsConn: 1, wsIn: 0, rpc: 0, alarms: 0, tickets: 3, calls: 0, events: 0, wakes: 0, rowsW: 0 }] });
    await rollupDay(env, date, { storeIds: [s.storeId] });
    await writeHistory(env, { kind: "history", storeId: s.storeId, rows: [], audits: [], usage: [{ h: `${date}T09`, wsConn: 0, wsIn: 0, rpc: 0, alarms: 0, tickets: 4, calls: 0, events: 0, wakes: 0, rowsW: 0 }] });
    const d = await env.DB.prepare("SELECT tickets FROM usage_daily WHERE store_id=? AND date=?").bind(s.storeId, date).first<any>();
    expect(d.tickets).toBe(7);
  });
});

// ---------- 推播計數 ----------

describe("q-push consumer：每批依店計數（ADR-044）", () => {
  it("成功＝sent；410／放棄＝sent＋failed；重試中不計", async () => {
    const sid = uniq("push");
    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const p256dh = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", ecdh.publicKey)) as ArrayBuffer));
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const ids = ["t_ok", "t_gone", "t_retry", "t_giveup"].map((x) => `${x}_${sid}`);
    for (const id of ids) {
      await env.DB.prepare("INSERT INTO push_subscriptions(ticket_id,store_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)").bind(id, sid, `https://push.example/${id}`, p256dh, auth, Date.now()).run();
    }
    const msg = (ticketId: string, attempts = 1) => ({ id: ticketId, timestamp: new Date(), attempts, body: { kind: "push", storeId: sid, ticketId, t: "called", n: "A001", c: 1, ahead: 0, recall: 0, at: Date.now() } });
    const batch = createMessageBatch("qcs-push-local", [msg(ids[0]), msg(ids[1]), msg(ids[2]), msg(ids[3], 4)] as any);
    const status: Record<string, number> = { [ids[0]]: 201, [ids[1]]: 410, [ids[2]]: 503, [ids[3]]: 503 };
    const NOW = Date.UTC(2026, 9, 22, 7, 30);
    await handlePushBatch(batch as any, env, { fetch: async (r) => new Response(null, { status: status[new URL(r.url).pathname.slice(1)] }), now: () => NOW });
    await getQueueResult(batch as any, {} as any).catch(() => null);
    const row = await env.DB.prepare("SELECT hour_start, push_sent, push_failed FROM usage_hourly WHERE store_id=?").bind(sid).first<any>();
    expect(row).toEqual({ hour_start: Date.UTC(2026, 9, 22, 7), push_sent: 3, push_failed: 2 });
  });
});

// ---------- Analytics Engine ----------

describe("Analytics Engine：每個 API 請求 1 點（mock binding）", () => {
  it("門店請求以 storeId 為 index、路由樣板、狀態類別、角色；平台請求為 _platform；未綁定時不寫也不出錯", async () => {
    const s = await seedStore();
    const points: AnalyticsEngineDataPoint[] = [];
    const e = envWith({ USAGE: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) } });
    const app = createApp();
    await app.request("/health", {}, e);
    await app.request(`/api/s/${s.code}/session?w=1&k=AAAAAAAAAA`, {}, e); // 401 QR_INVALID
    await app.request("/api/staff/device", { headers: { authorization: `Bearer ${s.staffDeviceToken}` } }, e);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ indexes: ["_platform"], blobs: ["/health", "GET", "2xx", "other"] });
    expect(points[1]).toMatchObject({ indexes: [s.storeId], blobs: ["/api/s/:code/session", "GET", "4xx", "customer"] });
    expect(points[2]).toMatchObject({ indexes: [s.storeId], blobs: ["/api/staff/device", "GET", "2xx", "staff"] });
    expect(points.every((p) => p.doubles?.[0] === 1 && (p.doubles?.[1] ?? -1) >= 0)).toBe(true);
    expect((await app.request("/health", {}, env)).status).toBe(200); // 本機無 binding
  });
});

function fakeAe(rows: { all?: any[]; err?: any[]; wake?: any[] }) {
  const sqls: string[] = [];
  const fetchFn = async (req: Request) => {
    const sql = await req.text();
    sqls.push(sql);
    expect(req.headers.get("authorization")).toBe("Bearer ae-token");
    expect(req.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    const data = sql.includes("blob1 = 'wake'") ? rows.wake : sql.includes("'5xx'") ? rows.err : rows.all;
    return Response.json({ data: data ?? [] });
  };
  return { sqls, fetchFn };
}
const aeEnv = () => envWith({ CF_ACCOUNT_ID: "acc123", AE_API_TOKEN: "ae-token", AE_DATASET: "qcs_usage" });

describe("Analytics Engine SQL 匯入（每日 Cron）", () => {
  it("依店依小時寫入 API 欄位；以 _sample_interval 加權；排除 DO 點；重跑不重複累加；不認得的 index 略過", async () => {
    const sid = (await seedStore()).storeId;
    const date = "2026-10-23";
    const ae = fakeAe({
      all: [
        { store: sid, hour: "2026-10-23 05:00:00", req: 120, wall: 2400 },
        { store: sid, hour: "2026-10-23 06:00:00", req: 30, wall: 300 },
        { store: "not-a-store", hour: "2026-10-23 06:00:00", req: 99, wall: 1 },
      ],
      err: [{ store: sid, hour: "2026-10-23 05:00:00", req: 2 }],
    });
    for (let i = 0; i < 2; i++) expect(await importAeDay(aeEnv(), date, ae.fetchFn)).toEqual({ rows: 2 });
    expect(await env.DB.prepare("SELECT 1 FROM usage_hourly WHERE store_id='not-a-store'").first()).toBeNull();
    expect(ae.sqls[0]).toContain("_sample_interval");
    expect(ae.sqls[0]).toContain("toDateTime('2026-10-23 00:00:00')");
    expect(ae.sqls[0]).toContain("toDateTime('2026-10-24 00:00:00')");
    expect(ae.sqls[0]).toContain("blob4 != 'do'");
    const rows = await env.DB.prepare("SELECT hour_start, api_requests, api_errors, api_wall_ms FROM usage_hourly WHERE store_id=? ORDER BY hour_start").bind(sid).all<any>();
    expect(rows.results).toEqual([
      { hour_start: Date.UTC(2026, 9, 23, 5), api_requests: 120, api_errors: 2, api_wall_ms: 2400 },
      { hour_start: Date.UTC(2026, 9, 23, 6), api_requests: 30, api_errors: 0, api_wall_ms: 300 },
    ]);
  });
  it("未設定 AE（本機）→ 略過，不呼叫網路", async () => {
    let called = false;
    expect(await importAeDay(env, "2026-10-23", async () => ((called = true), new Response("{}")))).toEqual({ skipped: "AE_NOT_CONFIGURED" });
    expect(called).toBe(false);
  });
  it("dataset 名稱不合法 → 略過（防 SQL 注入）", async () => {
    expect(await importAeDay(envWith({ CF_ACCOUNT_ID: "a", AE_API_TOKEN: "b", AE_DATASET: "x; DROP" }), "2026-10-23", async () => new Response("{}"))).toEqual({ skipped: "AE_DATASET_INVALID" });
  });
});

// ---------- 非營業時間、日彙總、估算成本 ----------

describe("非營業時間判斷", () => {
  const hours = [{ dow: 2, open: "11:00", close: "21:30" }, { dow: 5, open: "18:00", close: "02:00" }]; // 週二、週五跨午夜
  it("依門店時區與營業時間；跨午夜時段；未設定時以 02:00～06:00 為深夜", () => {
    const tp = (y: number, m: number, d: number, h: number) => Date.UTC(y, m - 1, d, h - 8); // 台北時間
    expect(isOffHours(tp(2026, 10, 27, 12), "Asia/Taipei", hours)).toBe(false); // 週二 12:00
    expect(isOffHours(tp(2026, 10, 27, 22), "Asia/Taipei", hours)).toBe(true);
    expect(isOffHours(tp(2026, 10, 31, 1), "Asia/Taipei", hours)).toBe(false); // 週六 01:00 屬週五跨午夜
    expect(isOffHours(tp(2026, 10, 31, 3), "Asia/Taipei", hours)).toBe(true);
    expect(isOffHours(tp(2026, 10, 27, 3), "Asia/Taipei", [])).toBe(true);
    expect(isOffHours(tp(2026, 10, 27, 12), "Asia/Taipei", [])).toBe(false);
  });
});

describe("日彙總與估算成本", () => {
  it("dailyFromHourly：DO 請求估算＝WS 訊息/20＋連線＋RPC＋alarm；活躍秒數＝事件×0.05＋喚醒×0.01；夜間喚醒取 DO 自計與 AE 較大者", () => {
    const tz = "Asia/Taipei";
    const night = Date.UTC(2026, 9, 26, 19); // 台北 03:00
    const day = Date.UTC(2026, 9, 26, 4); // 台北 12:00
    const d = dailyFromHourly("s", "2026-10-26", [
      { hour_start: day, api_requests: 1000, ws_messages: 400, ws_connects: 5, do_rpc: 30, do_alarms: 1, do_events: 200, do_wakes: 50, do_rows_written: 600, tickets: 40, push_sent: 10 },
      { hour_start: night, do_wakes: 3, do_night_wakes: 14 },
    ], tz, [], 2_000_000_000, 1234, 31);
    expect(d.do_requests_est).toBe(20 + 5 + 30 + 1);
    expect(d.do_active_seconds_est).toBeCloseTo(200 * 0.05 + 53 * 0.01, 5);
    expect(d.do_wakes_offhours).toBe(14);
    expect(d.do_wakes_offhours_max).toBe(14);
    expect(d.r2_bytes).toBe(2_000_000_000);
    expect(d.d1_history_rows).toBe(1234);
    expect(d.est_cost_usd).toBeCloseTo(estDayCost(d, 31).total, 9);
    expect(d.est_cost_usd).toBeGreaterThan(0);
  });

  it("估算成本分項：R2 依 GB-月單價按日攤；不扣內含額度", () => {
    const c = estDayCost({ api_requests: 1e6, do_requests_est: 1e6, do_active_seconds_est: 0, do_rows_written_est: 0, tickets: 0, push_sent: 0, r2_bytes: 30e9 }, 30);
    expect(c.parts.workers).toBeCloseTo(0.3 + 3 * 0.02, 9);
    expect(c.parts.doRequests).toBeCloseTo(0.15, 9);
    expect(c.parts.r2).toBeCloseTo(0.015, 9);
  });

  it("rollupDay：每家未封存門店一列（含無活動）、r2_bytes 來自 ad_assets、冪等", async () => {
    const s = await seedStore();
    const date = "2026-10-24";
    await env.DB.prepare("INSERT INTO ad_assets(id,owner_type,owner_id,kind,r2_key,sha256,mime,bytes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(`${s.storeId}_a1`, "store", s.storeId, "image", "k", "h", "image/png", 5_000_000, "ready", Date.now()).run();
    await env.DB.prepare("INSERT INTO usage_hourly(store_id,hour_start,tickets,ws_connects) VALUES(?,?,?,?)").bind(s.storeId, Date.UTC(2026, 9, 24, 3), 12, 2).run();
    await rollupDay(env, date);
    await rollupDay(env, date);
    const rows = await env.DB.prepare("SELECT * FROM usage_daily WHERE store_id=? AND date=?").bind(s.storeId, date).all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ tickets: 12, ws_connects: 2, r2_bytes: 5_000_000 });
  });

  it("ensureDaily：只補「有小時資料、沒有日彙總」的過去日子，不算今天", async () => {
    const s = await seedStore();
    const now = Date.UTC(2026, 10, 3, 10);
    await env.DB.prepare("INSERT INTO usage_hourly(store_id,hour_start,tickets) VALUES(?,?,?),(?,?,?)").bind(s.storeId, Date.UTC(2026, 10, 1, 3), 5, s.storeId, Date.UTC(2026, 10, 3, 3), 7).run();
    const done = await ensureDaily(env, "2026-11-01", "2026-11-03", now);
    expect(done).toContain("2026-11-01");
    expect(done).not.toContain("2026-11-03");
    expect(await ensureDaily(env, "2026-11-01", "2026-11-03", now)).toEqual([]);
  });
});

// ---------- 分攤 ----------

const mrow = (id: string, over: Partial<MonthRow>): MonthRow => ({
  ...monthFromDaily(id, "2026-09", []),
  active_days: 30,
  ...over,
});

describe("帳單分攤（12 §5）", () => {
  it("各項依對應用量占比；Workers 月費由活躍付費門店平均；平台與內部門店不分月費；總額守恆", () => {
    const rows = [
      mrow("A", { api_requests: 300, do_requests_est: 100, tickets: 90, r2_byte_days: 0, est_cost_usd: 1 }),
      mrow("B", { api_requests: 100, do_requests_est: 300, tickets: 10, r2_byte_days: 1000, est_cost_usd: 1 }),
      mrow("_platform", { api_requests: 100, est_cost_usd: 0.1 }),
      mrow("I", { api_requests: 0, tickets: 0, est_cost_usd: 0 }),
      mrow("Z", { active_days: 0 }),
    ];
    const bill = { workers_base: 5, workers_requests: 1, do_requests: 2, d1: 1, r2: 0.5 };
    const a = allocate(rows, bill, new Set(["I"]));
    expect(a.get("A")).toBeCloseTo(2.5 + 0.6 + 0.5 + 0.9, 6);
    expect(a.get("B")).toBeCloseTo(2.5 + 0.2 + 1.5 + 0.1 + 0.5, 6);
    expect(a.get("_platform")).toBeCloseTo(0.2, 6);
    expect(a.get("I")).toBe(0);
    expect(a.get("Z")).toBe(0);
    const total = [...a.values()].reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(9.5, 6);
  });
  it("某項全部用量為 0 → 改依估算成本占比；估算也為 0 → 活躍門店平均（金額不消失）", () => {
    const rows = [mrow("A", { est_cost_usd: 3 }), mrow("B", { est_cost_usd: 1 })];
    const a = allocate(rows, { queues: 4 }, new Set());
    expect(a.get("A")).toBeCloseTo(3, 6);
    const b = allocate([mrow("A", {}), mrow("B", {})], { kv: 2 }, new Set());
    expect(b.get("A")).toBeCloseTo(1, 6);
  });
});

// ---------- 月彙總＋警示＋Cron ----------

describe("月彙總、警示、Cron", () => {
  it("buildMonth：日加總、r2_byte_days、估算總額；輸入帳單後有分攤；persistMonth 寫 usage_monthly", async () => {
    const s = await seedStore();
    const month = "2026-08";
    for (const [d, t] of [["2026-08-02", 10], ["2026-08-03", 20]] as const) {
      await env.DB.prepare("INSERT INTO usage_hourly(store_id,hour_start,tickets,api_requests) VALUES(?,?,?,?)").bind(s.storeId, Date.parse(`${d}T03:00:00Z`), t, t * 7).run();
    }
    const now = Date.UTC(2026, 8, 5);
    let rep = await buildMonth(env, month, now);
    const mine = rep.rows.find((r) => r.store_id === s.storeId)!;
    expect(mine).toMatchObject({ tickets: 30, api_requests: 210, active_days: 2, allocated_cost_usd: null });
    expect(rep.complete).toBe(true);
    expect(rep.overview.actualUsd).toBeNull();
    await env.DB.prepare("INSERT OR REPLACE INTO billing_inputs(month,line_item,amount_usd,source,entered_by,entered_at) VALUES(?,?,?,?,?,?)").bind(month, "workers_base", 5, "invoice", "dev@local", now).run();
    rep = await buildMonth(env, month, now);
    expect(rep.overview.actualUsd).toBe(5);
    expect(rep.rows.find((r) => r.store_id === s.storeId)!.allocated_cost_usd).toBeGreaterThan(0);
    await persistMonth(env, rep);
    const m = await env.DB.prepare("SELECT tickets, allocated_cost_usd FROM usage_monthly WHERE store_id=? AND month=?").bind(s.storeId, month).first<any>();
    expect(m.tickets).toBe(30);
    expect(m.allocated_cost_usd).toBeGreaterThan(0);
  });

  it("警示：請求暴增、每號請求過高、推播失敗率、廣告容量（90% 黃、100% 紅）", async () => {
    const s = await seedStore({ adQuota: 1000 });
    const now = Date.UTC(2026, 9, 15, 6);
    const ins = (date: string, o: Record<string, number>) =>
      env.DB.prepare(`INSERT OR REPLACE INTO usage_daily(store_id,date,${Object.keys(o).join(",")}) VALUES(?,?,${Object.keys(o).map(() => "?").join(",")})`).bind(s.storeId, date, ...Object.values(o)).run();
    for (let d = 7; d <= 13; d++) await ins(`2026-10-${String(d).padStart(2, "0")}`, { api_requests: 2000 });
    await ins("2026-10-14", { api_requests: 9000, tickets: 10, do_requests_est: 300, push_sent: 20, push_failed: 6 });
    await env.DB.prepare("INSERT INTO ad_assets(id,owner_type,owner_id,kind,r2_key,sha256,mime,bytes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(`${s.storeId}_q`, "store", s.storeId, "image", "k", "h", "image/png", 950, "ready", now).run();
    let a = (await storeAlerts(env, [s.storeId], now)).get(s.storeId)!;
    expect(a.map((x) => x.kind).sort()).toEqual(["ad_quota", "per_ticket", "push_fail", "request_spike"]);
    expect(a.find((x) => x.kind === "ad_quota")!.level).toBe("amber");
    await env.DB.prepare("UPDATE ad_assets SET bytes=1000 WHERE id=?").bind(`${s.storeId}_q`).run();
    a = (await storeAlerts(env, [s.storeId], now)).get(s.storeId)!;
    expect(a.find((x) => x.kind === "ad_quota")!.level).toBe("red");
  });

  it("推播樣本太少（< 10）不判失敗率；請求量低於 5,000 不判暴增", async () => {
    const s = await seedStore();
    const now = Date.UTC(2026, 9, 15, 6);
    await env.DB.prepare("INSERT INTO usage_daily(store_id,date,api_requests,push_sent,push_failed) VALUES(?,?,?,?,?),(?,?,?,?,?)").bind(s.storeId, "2026-10-13", 10, 0, 0, s.storeId, "2026-10-14", 4000, 3, 3).run();
    expect((await storeAlerts(env, [s.storeId], now)).get(s.storeId)).toEqual([]);
  });

  it("Cron 分派：UTC 01 點做前一日彙總（含 AE 匯入）；每月 1 日 02 點月結；其他時刻不動作", async () => {
    const ae = fakeAe({});
    expect(await runUsageCron(aeEnv(), Date.UTC(2026, 9, 26, 5, 5), ae.fetchFn)).toEqual({});
    const r = await runUsageCron(aeEnv(), Date.UTC(2026, 9, 26, 1, 5), ae.fetchFn);
    expect(r.daily).toMatchObject({ date: "2026-10-25" });
    expect(r.ae).toEqual({ rows: 0 });
    const m = await runUsageCron(env, Date.UTC(2026, 10, 1, 2, 5), ae.fetchFn);
    expect(m.monthly).toMatchObject({ month: "2026-10" });
  });
});

describe("4.4 人為製造夜間喚醒 → 出現「夜間 DO 未休眠」警示", () => {
  it("DO 在非營業時間被反覆喚醒（無任何寫入）→ AE 夜間喚醒點 → 每日匯入／彙總 → 門店列表紅色警示", async () => {
    const s = await seedStore();
    const now = Date.now();
    // 營業時間只設在「不是今天」的星期 → 現在一定是非營業時間（DO 用真實時鐘判斷：驅逐後測試時鐘會消失）
    const todayDow = new Date(now + 8 * H).getUTCDay();
    const hours = [{ dow: (todayDow + 3) % 7, open: "11:00", close: "12:00" }];
    await env.DB.prepare("UPDATE stores SET business_hours=? WHERE id=?").bind(JSON.stringify(hours), s.storeId).run();
    const ctx = storeCtx(s.storeId, { businessHours: hours });
    const points: AnalyticsEngineDataPoint[] = [];
    StoreQueueDO.aeSink = { writeDataPoint: (p) => points.push(p) };
    await stubFor(s.storeId).summary(ctx); // 建立 DO＋寫入門店設定
    points.length = 0;
    for (let i = 0; i < 12; i++) {
      await evictDurableObject(stubFor(s.storeId));
      await stubFor(s.storeId).summary(ctx); // 只喚醒、不寫入
    }
    expect(points).toHaveLength(12);
    expect(points[0]).toMatchObject({ indexes: [s.storeId], blobs: ["wake", "DO", "-", "do"] });
    // 模擬 AE 儲存：依店依小時加總後由 SQL API 回傳
    const hour = new Date(Math.floor(now / H) * H).toISOString().slice(0, 19).replace("T", " ");
    const ae = fakeAe({ wake: [{ store: s.storeId, hour, req: points.length }] });
    const date = new Date(now).toISOString().slice(0, 10);
    await importAeDay(aeEnv(), date, ae.fetchFn);
    await rollupDay(env, date, { storeIds: [s.storeId] });
    const daily = await env.DB.prepare("SELECT do_wakes_offhours, do_wakes_offhours_max FROM usage_daily WHERE store_id=? AND date=?").bind(s.storeId, date).first<any>();
    expect(daily).toEqual({ do_wakes_offhours: 12, do_wakes_offhours_max: 12 });
    const app = createApp({ now: () => now + DAY });
    const list = (await (await app.request(`/api/admin/stores?q=${s.code}`, {}, env)).json()) as any;
    expect(list.stores[0].alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "night_wake", level: "red" })]));
  });

  it("營業時間內的喚醒不寫 AE 點（白天量大且正常）", async () => {
    const id = uniq();
    const now = Date.now();
    const todayDow = new Date(now + 8 * H).getUTCDay();
    const ctx = storeCtx(id, { businessHours: [{ dow: todayDow, open: "00:00", close: "23:59" }, { dow: (todayDow + 1) % 7, open: "00:00", close: "23:59" }] });
    const points: unknown[] = [];
    StoreQueueDO.aeSink = { writeDataPoint: (p) => points.push(p) };
    await stubFor(id).summary(ctx);
    for (let i = 0; i < 3; i++) {
      await evictDurableObject(stubFor(id));
      await stubFor(id).summary(ctx);
    }
    expect(points).toHaveLength(0);
  });
});

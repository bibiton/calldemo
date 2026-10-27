import { describe, expect, it } from "vitest";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "./test-env";
import { createApp } from "../src/app";
import worker from "../src/index";
import { aggregateDay, computeDailyStats } from "../src/reports";
import { seedStore, type Seeded } from "./fixtures";

const app = createApp();
const MIN = 60_000;
// 台北 2054-10-20：營業日當天 10:00 = UTC 02:00
const D = "2054-10-20";
const at = (hh: number, mm = 0) => Date.UTC(2054, 9, 20, hh - 8, mm);

/** 區間報表只補算「今天以前」的日子：用固定時鐘（D 之後幾天），不依賴真實日期。 */
const appAfterD = createApp({ now: () => Date.UTC(2054, 9, 25, 4) });

async function admin(s: Seeded, a = app) {
  return ((await (await a.request("/api/store/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: s.adminEmail, password: s.adminPassword }) }, env)).json()) as any).accessToken as string;
}

let n = 0;
function hist(storeId: string, svc: string, o: { status: string; created: number; called?: number | null; serving?: number | null; ended: number; bd?: string }) {
  return env.DB.prepare(
    "INSERT INTO tickets_history(id,store_id,business_date,service_id,number,final_status,created_at,called_at,serving_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).bind(`h_${storeId}_${n++}`, storeId, o.bd ?? D, svc, `A${n}`, o.status, o.created, o.called ?? null, o.serving ?? null, o.ended);
}

/** 10 筆 A：等候 1..10 分鐘（叫號）→ 完成 8、過號 1、未到 1；另 1 筆取消（未叫號）。尖峰 12 點（6 筆）。B：2 筆完成。 */
async function seedHistory(s: Seeded) {
  const A = `${s.storeId}_A`;
  const B = `${s.storeId}_B`;
  const rows: D1PreparedStatement[] = [];
  for (let i = 1; i <= 10; i++) {
    const created = i <= 6 ? at(12, i) : at(15, i);
    const called = created + i * MIN;
    const status = i === 9 ? "skipped" : i === 10 ? "no_show" : "done";
    const serving = status === "done" ? called + MIN : null;
    rows.push(hist(s.storeId, A, { status, created, called, serving, ended: status === "done" ? serving! + 4 * MIN : called + 5 * MIN }));
  }
  rows.push(hist(s.storeId, A, { status: "cancelled", created: at(13), ended: at(13, 5) }));
  rows.push(hist(s.storeId, B, { status: "done", created: at(18), called: at(18, 2), serving: at(18, 3), ended: at(18, 5) }));
  rows.push(hist(s.storeId, B, { status: "done", created: at(18, 10), called: at(18, 14), serving: at(18, 15), ended: at(18, 25) }));
  // 別天的資料不可混入
  rows.push(hist(s.storeId, A, { status: "done", created: at(12), called: at(12, 1), ended: at(12, 2), bd: "2054-10-19" }));
  await env.DB.batch(rows);
}

describe("3.6 報表：daily_stats 與 tickets_history 一致", () => {
  it("aggregateDay：取號數、各終態、平均／P90 等候、平均服務、尖峰時段（門店時區）", () => {
    const rows = Array.from({ length: 10 }, (_, k) => {
      const i = k + 1;
      return { service_id: "A", final_status: i === 10 ? "no_show" : "done", created_at: at(12, i), called_at: at(12, i) + i * MIN, serving_at: at(12, i) + i * MIN, ended_at: at(12, i) + i * MIN + 2 * MIN };
    });
    const out = aggregateDay(rows, "Asia/Taipei");
    expect(out).toEqual([
      { service_id: "A", issued: 10, done: 9, skipped: 0, no_show: 1, cancelled: 0, avg_wait_ms: 5.5 * MIN, p90_wait_ms: 9 * MIN, avg_service_ms: 2 * MIN, peak_hour: 12 },
    ]);
  });

  it("computeDailyStats 寫入 daily_stats；數字逐欄等於 tickets_history 的實際計算；重跑冪等", async () => {
    const s = await seedStore();
    await seedHistory(s);
    await computeDailyStats(env, s.storeId, D, "Asia/Taipei");
    await computeDailyStats(env, s.storeId, D, "Asia/Taipei");
    const rows = (await env.DB.prepare("SELECT * FROM daily_stats WHERE store_id=? ORDER BY service_id").bind(s.storeId).all()).results as any[];
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.service_id.endsWith("_A"));
    expect(a).toMatchObject({ business_date: D, issued: 11, done: 8, skipped: 1, no_show: 1, cancelled: 1, peak_hour: 12 });
    expect(a.avg_wait_ms).toBe(5.5 * MIN); // 1..10 分鐘平均
    expect(a.p90_wait_ms).toBe(9 * MIN); // nearest-rank：第 9 小
    expect(a.avg_service_ms).toBe(4 * MIN);
    // 與 tickets_history 直接計算比對
    const raw = (await env.DB.prepare("SELECT count(*) AS n, sum(final_status='done') AS d FROM tickets_history WHERE store_id=? AND business_date=? AND service_id=?").bind(s.storeId, D, a.service_id).first()) as any;
    expect(a.issued).toBe(raw.n);
    expect(a.done).toBe(raw.d);
    const b = rows.find((r) => r.service_id.endsWith("_B"));
    expect(b).toMatchObject({ issued: 2, done: 2, avg_wait_ms: 3 * MIN, avg_service_ms: 6 * MIN, peak_hour: 18 });
  });

  it("每小時 Cron：門店當地 03 點時結算昨天", async () => {
    const s = await seedStore();
    await seedHistory(s);
    const ctl = createScheduledController({ cron: "5 * * * *", scheduledTime: Date.UTC(2054, 9, 20, 19, 5) }); // 台北 10/21 03:05
    await worker.scheduled(ctl, env, createExecutionContext() as any);
    const n2 = (await env.DB.prepare("SELECT count(*) AS n FROM daily_stats WHERE store_id=? AND business_date=?").bind(s.storeId, D).first<{ n: number }>())!.n;
    expect(n2).toBe(2);
  });

  it("GET /api/store/reports/daily：區間內缺的日子即時補算；CSV 有 BOM 與中文表頭、數字一致", async () => {
    const s = await seedStore();
    await seedHistory(s);
    const t = await admin(s, appAfterD);
    const r = await appAfterD.request(`/api/store/reports/daily?from=2054-10-19&to=2054-10-20`, { headers: { authorization: `Bearer ${t}` } }, env);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    const a = b.rows.find((x: any) => x.businessDate === D && x.serviceId.endsWith("_A"));
    expect(a).toMatchObject({ issued: 11, done: 8, skipped: 1, noShow: 1, cancelled: 1, avgWaitMs: 5.5 * MIN, p90WaitMs: 9 * MIN, peakHour: 12, serviceName: "內用" });
    expect(b.rows.some((x: any) => x.businessDate === "2054-10-19")).toBe(true);
    const csv = await appAfterD.request(`/api/store/reports/daily.csv?from=2054-10-19&to=2054-10-20`, { headers: { authorization: `Bearer ${t}` } }, env);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment/);
    const raw = new Uint8Array(await csv.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM（.text() 會依規範去掉，所以看位元組）
    const lines = new TextDecoder().decode(raw).trim().split("\r\n");
    expect(lines[0]).toBe("日期,服務,取號數,完成,過號,未到,取消,完成率,平均等候(分),P90等候(分),平均服務(分),尖峰時段");
    expect(lines).toContain("2054-10-20,A 內用,11,8,1,1,1,72.7%,5.5,9.0,4.0,12:00");
    expect((await appAfterD.request(`/api/store/reports/daily?from=2054-10-01&to=2054-12-31`, { headers: { authorization: `Bearer ${t}` } }, env)).status).toBe(422);
  });

  it("GET /api/store/reports/today：DO 即時數字（取號、等候、叫號中、完成）", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const { computeQrToken, deriveStoreKey, qrWindow } = await import("@qcs/shared");
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    for (let i = 0; i < 3; i++) {
      const w = qrWindow(Date.now());
      const sess: any = await (await app.request(`/api/s/${s.code}/session?w=${w}&k=${await computeQrToken(key, s.storeId, w)}`, {}, env)).json();
      await app.request(`/api/s/${s.code}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: `客${i}`, phone: `091200000${i}`, consent: true }) }, env);
    }
    // 人員以真實 token 連線：叫號 2 次（第 2 次自動完成第 1 號，ADR-029）
    const st: any = await (await app.request("/api/staff/login", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.staffDeviceToken}` }, body: JSON.stringify({ userId: s.staffUserId, pin: s.pin }) }, env)).json();
    const res = await app.request(`/ws/store/${s.storeId}?role=staff`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${st.token}` } }, env);
    const ws = res.webSocket!;
    ws.accept();
    const acks: any[] = [];
    ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.t === "ack") acks.push(m); });
    for (const id of ["n1", "n2"]) ws.send(JSON.stringify({ t: "cmd", cmdId: id, cmd: "callNext", args: { counterId: `${s.storeId}_c1` } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(acks.map((x) => x.ok)).toEqual([true, true]);
    ws.close();
    const r: any = await (await app.request("/api/store/reports/today", { headers: { authorization: `Bearer ${t}` } }, env)).json();
    const a = r.services.find((x: any) => x.serviceId === `${s.storeId}_A`);
    expect(a).toMatchObject({ issued: 3, waiting: 1, called: 1, done: 1 });
    expect(r.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("店長即時隊列：以 access token 連 WS（role=staff）可代操作", () => {
  it("店長 token 連線 → snapshot 含姓名；可叫號", async () => {
    const s = await seedStore();
    const t = await admin(s);
    const res = await app.request(`/ws/store/${s.storeId}?role=staff`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `qcs.v1, auth.${t}` } }, env);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const msgs: any[] = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
    await new Promise((r) => setTimeout(r, 50));
    expect(msgs.some((m) => m.type === "snapshot" && m.data.staff)).toBe(true);
    ws.send(JSON.stringify({ t: "cmd", cmdId: "c1", cmd: "callNext", args: { counterId: `${s.storeId}_c1` } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(msgs.find((m) => m.t === "ack" && m.cmdId === "c1")).toMatchObject({ ok: false, error: "QUEUE_EMPTY" });
    ws.close();
  });
});

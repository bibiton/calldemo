/**
 * DEMO 模擬叫號（13-demo-seed §5）：DO alarm 驅動、與關店 alarm 共用同一個 storage alarm。
 */
import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { isType, openWs, storeCtx, stubFor, take, uniq, type TestSocket } from "./helpers";
import type { StoreCtx, StoreQueueDO } from "../src/do/store-queue";
import { pickAction, simEnabled, simIntervalMs } from "../src/do/demo-sim";
import { computeQrToken, deriveStoreKey, qrWindow } from "@qcs/shared";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { seedStore, type Seeded } from "./fixtures";

const NOON = Date.UTC(2030, 9, 29, 4, 0); // 台北 2030/10/29（二）12:00；用未來時刻，免得 miniflare 立刻自動觸發已過期的 alarm
const CLOSE = Date.UTC(2030, 9, 29, 16, 29); // 無營業時間設定 → 台北 23:59＋30 分
const DAY = 24 * 3600_000;
const STEP = 20_000; // DEMO_SIM_EVERY_SEC 未設定 → 預設 20 秒

const ON = { demo: true, demoSimulate: true };

function ctxWith(id: string, features: Record<string, boolean>, over: Partial<StoreCtx["store"]> = {}, v = 1): StoreCtx {
  return { ...storeCtx(id, { features, ...over }), v };
}

const setClock = (id: string, t: number) => runInDurableObject(stubFor(id), (i: StoreQueueDO) => i.setClock(() => t));

async function prep(id: string, t = NOON) {
  await runInDurableObject(stubFor(id), (i: StoreQueueDO) => {
    i.setClock(() => t);
    i.captureHistory = true;
    i.capturePush = true;
    i.simRandom = () => 0; // 固定：第一個服務、第一個姓名、叫下一號
  });
}

const getAlarm = (id: string) => runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => st.storage.getAlarm());
const meta = (id: string, key: string) =>
  runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => (st.storage.sql.exec("SELECT value FROM meta WHERE key=?", key).toArray()[0] as any)?.value ?? null);
const tickets = (id: string) =>
  runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) =>
    st.storage.sql.exec("SELECT number, status, name, phone, source, staff_id, business_date, counter_id FROM tickets ORDER BY ord").toArray() as any[],
  );

async function display(id: string, ctx: StoreCtx): Promise<TestSocket> {
  const d = await openWs(id, { role: "display", deviceId: `${id}_d1` }, { ctx });
  await d.next(isType("snapshot"));
  return d;
}

describe("demo-sim 純函式", () => {
  it("(h) 間隔：預設 20 秒，限制 10～600 秒，非數字用預設", () => {
    expect(simIntervalMs(undefined)).toBe(20_000);
    expect(simIntervalMs("")).toBe(20_000);
    expect(simIntervalMs("abc")).toBe(20_000);
    expect(simIntervalMs("30")).toBe(30_000);
    expect(simIntervalMs("10")).toBe(10_000);
    expect(simIntervalMs("9")).toBe(10_000);
    expect(simIntervalMs("0")).toBe(10_000);
    expect(simIntervalMs("-5")).toBe(10_000);
    expect(simIntervalMs("600")).toBe(600_000);
    expect(simIntervalMs("601")).toBe(600_000);
    expect(simIntervalMs("99999")).toBe(600_000);
  });

  it("開關：demo 與 demoSimulate 都要是 true", () => {
    expect(simEnabled({ demo: true, demoSimulate: true })).toBe(true);
    expect(simEnabled({ demo: true, demoSimulate: false })).toBe(false);
    expect(simEnabled({ demo: false, demoSimulate: true })).toBe(false);
    expect(simEnabled({ demoSimulate: true })).toBe(false);
    expect(simEnabled({})).toBe(false);
    expect(simEnabled(undefined)).toBe(false);
  });

  it("動作比例：< 0.85 叫下一號、< 0.95 重叫、其餘過號", () => {
    expect(pickAction(0)).toBe("callNext");
    expect(pickAction(0.849)).toBe("callNext");
    expect(pickAction(0.85)).toBe("recall");
    expect(pickAction(0.949)).toBe("recall");
    expect(pickAction(0.95)).toBe("skip");
    expect(pickAction(0.999)).toBe("skip");
  });
});

describe("DO 模擬叫號", () => {
  it("(a) 功能關閉：面板連線也不排 alarm、不產生號碼", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, {}));
    expect(await getAlarm(id)).toBeNull();
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(false);
    expect(await tickets(id)).toEqual([]);
    d.ws.close();
  });

  it("(b) demo 開但 demoSimulate 關：不排 alarm、不產生號碼", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, { demo: true, demoSimulate: false }));
    expect(await getAlarm(id)).toBeNull();
    expect(await tickets(id)).toEqual([]);
    d.ws.close();
  });

  it("demoSimulate 開但不是 demo 門店：不生效", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, { demoSimulate: true }));
    expect(await getAlarm(id)).toBeNull();
    d.ws.close();
  });

  it("(c) 兩者都開＋面板連線＋營業時間：每步補號並叫號，面板收到 ticket.created／ticket.called", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, ON));
    expect(await getAlarm(id)).toBe(NOON + STEP); // 面板連上即排第一步

    await setClock(id, NOON + STEP);
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    const created = await d.next(isType("ticket.created"));
    expect(created.data.number).toBe("A001");
    const called = await d.next(isType("ticket.called"));
    expect(called.data).toMatchObject({ number: "A001", status: "called", counterNo: 1 });

    const rows = await tickets(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "called", source: "staff", staff_id: null, phone: null, counter_id: "c1" });
    expect(typeof rows[0].name).toBe("string");
    // 下一步已排；關店 alarm 也已排（比下一步晚）→ storage alarm 是較早的模擬步
    expect(await meta(id, "close_at")).toBe(String(CLOSE));
    expect(await getAlarm(id)).toBe(NOON + 2 * STEP);

    // 第二步：叫下一號輪到下一個櫃台（c2），c1 的上一號維持 called（叫號只結束同櫃台的號碼）
    await setClock(id, NOON + 2 * STEP);
    await runDurableObjectAlarm(stubFor(id));
    const c2 = await d.next(isType("ticket.called"));
    expect(c2.data).toMatchObject({ number: "A002", counterNo: 2 });
    d.ws.close();
  });

  it("(c) 等候已有 4 張就不再補號；重叫／過號作用在最近叫的號碼", async () => {
    const id = uniq("sim");
    await prep(id);
    const ctx = ctxWith(id, ON);
    for (let i = 1; i <= 4; i++) await stubFor(id).takeTicket(ctx, { jti: `j${i}`, serviceId: "svc_a", name: `顧客${i}`, phone: `09${String(10000000 + i).slice(-8)}` });
    const d = await display(id, ctx);
    await runDurableObjectAlarm(stubFor(id));
    let rows = await tickets(id);
    expect(rows).toHaveLength(4); // 沒有補號
    expect(rows.filter((r) => r.status === "called")).toHaveLength(1);

    await runInDurableObject(stubFor(id), (i: StoreQueueDO) => (i.simRandom = () => 0.9)); // 重叫
    await setClock(id, NOON + STEP);
    await runDurableObjectAlarm(stubFor(id));
    const re = await d.next((m) => m.type === "ticket.called" && m.data.recallCount === 1);
    expect(re.data.number).toBe("A001");

    await runInDurableObject(stubFor(id), (i: StoreQueueDO) => (i.simRandom = () => 0.99)); // 過號
    await setClock(id, NOON + 2 * STEP);
    await runDurableObjectAlarm(stubFor(id));
    const sk = await d.next(isType("ticket.skipped"));
    expect(sk.data.number).toBe("A001");
    rows = await tickets(id);
    expect(rows.find((r) => r.number === "A001")!.status).toBe("skipped");
    d.ws.close();
  });

  it("(d) 沒有面板連線：下一步不執行且不再排", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, ON));
    d.ws.close();
    await d.closed;
    // 等 DO 端處理完關閉
    for (let i = 0; i < 50; i++) {
      const n = await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => st.getWebSockets("role:display").length);
      if (n === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await getAlarm(id)).toBe(NOON + STEP);
    await setClock(id, NOON + STEP);
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect(await tickets(id)).toEqual([]);
    expect(await meta(id, "sim_at")).toBe("");
    expect(await getAlarm(id)).toBeNull();
  });

  it("(d) 只有人員端連線（沒有面板）：設定開啟也不啟動", async () => {
    const id = uniq("sim");
    await prep(id);
    const s = await openWs(id, { role: "staff", staffId: "u1", deviceId: "sd1" }, { ctx: ctxWith(id, ON) });
    await s.next(isType("snapshot"));
    await stubFor(id).configChanged(ctxWith(id, ON, {}, 2));
    expect(await getAlarm(id)).toBeNull();
    s.ws.close();
  });

  it("(e) 非營業時間：不取號不叫號，暫停到下一個營業時刻（不在夜裡喚醒）", async () => {
    const id = uniq("sim");
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, open: "11:00", close: "21:30" }));
    const t0 = Date.UTC(2030, 9, 29, 13, 0); // 台北 21:00，營業中
    await prep(id, t0);
    const d = await display(id, ctxWith(id, ON, { businessHours: hours }));
    expect(await getAlarm(id)).toBe(t0 + STEP);
    await setClock(id, Date.UTC(2030, 9, 29, 14, 0)); // 台北 22:00，已打烊
    await runDurableObjectAlarm(stubFor(id));
    expect(await tickets(id)).toEqual([]);
    const next = Date.UTC(2030, 9, 30, 3, 0); // 台北 10/30 11:00 開門
    expect(await meta(id, "sim_at")).toBe(String(next));
    expect(await getAlarm(id)).toBe(next);
    // 開門後恢復
    await setClock(id, next);
    await runDurableObjectAlarm(stubFor(id));
    expect((await tickets(id)).map((r) => r.status)).toEqual(["called"]);
    d.ws.close();
  });

  it("(e) 在非營業時間連上面板：直接排到開門時刻", async () => {
    const id = uniq("sim");
    await prep(id, Date.UTC(2030, 9, 29, 19, 0)); // 台北 10/30 03:00（無營業時間設定 → 02～06 為深夜）
    const d = await display(id, ctxWith(id, ON));
    expect(await getAlarm(id)).toBe(Date.UTC(2030, 9, 29, 22, 0)); // 台北 06:00
    d.ws.close();
  });

  it("(f) 關店 alarm 與模擬步交錯：關店時刻不變、照常結算，之後的號碼排到下一個營業日", async () => {
    const id = uniq("sim");
    const t0 = Date.UTC(2030, 9, 29, 15, 50); // 台北 23:50
    await prep(id, t0);
    const d = await display(id, ctxWith(id, ON));
    await setClock(id, t0 + STEP);
    await runDurableObjectAlarm(stubFor(id)); // A001 取號＋叫號（10/29）
    await setClock(id, t0 + 2 * STEP);
    await runDurableObjectAlarm(stubFor(id)); // A002（10/29）
    expect(await meta(id, "close_at")).toBe(String(CLOSE));
    expect(await getAlarm(id)).toBe(t0 + 3 * STEP); // 模擬步較早

    // 時間跳到關店時刻之後：同一次 alarm 先關店、再跑一步模擬
    const after = CLOSE + 60_000; // 台北 10/30 00:30
    await setClock(id, after);
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    const closed = await d.next(isType("store.closed"));
    expect(closed.data.businessDate).toBe("2030-10-29");
    const rows = await tickets(id);
    const old = rows.filter((r) => r.business_date === "2030-10-29");
    expect(old.map((r) => r.status).sort()).toEqual(["no_show", "no_show"]); // 叫了未結束 → no_show（同關店語意）
    expect(old.every((r) => r.name === null && r.phone === null)).toBe(true);
    const sent = await runInDurableObject(stubFor(id), (i: StoreQueueDO) => i.captured);
    expect(sent.flatMap((m: any) => m.rows).filter((r: any) => r.business_date === "2030-10-29")).toHaveLength(2);
    // 新營業日的號碼從 001 起，並排了新的關店 alarm
    const fresh = rows.filter((r) => r.business_date === "2030-10-30");
    expect(fresh.map((r) => r.number)).toEqual(["A001"]);
    expect(await meta(id, "close_at")).toBe(String(Date.UTC(2030, 9, 30, 16, 29)));
    expect(await getAlarm(id)).toBe(after + STEP);
    d.ws.close();
  });

  it("(f) 功能關閉時關店 alarm 行為不變（取號排關店、alarm 結算後清除）", async () => {
    const id = uniq("sim");
    await prep(id);
    await take(id, 1);
    expect(await getAlarm(id)).toBe(CLOSE);
    expect(await meta(id, "sim_at")).toBeNull();
    await setClock(id, CLOSE + 60_000);
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect((await tickets(id)).map((r) => r.status)).toEqual(["no_show"]);
    expect(await getAlarm(id)).toBeNull();
    expect(await meta(id, "close_at")).toBe("");
  });

  it("(g) configChanged 關閉模擬：立即取消模擬 alarm，關店 alarm 保留", async () => {
    const id = uniq("sim");
    await prep(id);
    const d = await display(id, ctxWith(id, ON));
    await runDurableObjectAlarm(stubFor(id)); // 一步（產生號碼 → 排關店）
    expect(await getAlarm(id)).toBe(NOON + STEP);
    await stubFor(id).configChanged(ctxWith(id, { demo: true, demoSimulate: false }, {}, 2));
    expect(await meta(id, "sim_at")).toBe("");
    expect(await getAlarm(id)).toBe(CLOSE);
    const before = (await tickets(id)).length;
    await setClock(id, CLOSE + 60_000);
    await runDurableObjectAlarm(stubFor(id)); // 只剩關店
    expect((await tickets(id)).length).toBe(before);
    // 再開啟：面板仍連線 → 重新排
    await setClock(id, NOON + DAY);
    await stubFor(id).configChanged(ctxWith(id, ON, {}, 3));
    expect(await getAlarm(id)).toBe(NOON + DAY + STEP);
    d.ws.close();
  });

  it("停用門店：下一步不執行且不再排", async () => {
    const id = uniq("sim");
    await prep(id);
    await display(id, ctxWith(id, ON));
    await stubFor(id).suspend("suspended");
    await runDurableObjectAlarm(stubFor(id));
    expect(await tickets(id)).toEqual([]);
    expect(await getAlarm(id)).toBeNull();
  });
});

describe("面板與顧客頁得知 DEMO 門店（浮水印）", () => {
  const T = NOON;
  const appAt = createApp({ now: () => T });
  const custSession = async (s: Seeded) => {
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    const w = qrWindow(T);
    return (await (await appAt.request(`/api/s/${s.code}/session?w=${w}&k=${await computeQrToken(key, s.storeId, w)}`, {}, env)).json()) as any;
  };
  const demoStore = async (features: Record<string, boolean>) => {
    const s = await seedStore();
    await env.DB.prepare("UPDATE stores SET features=? WHERE id=?").bind(JSON.stringify(features), s.storeId).run();
    return s;
  };

  it("DEMO 門店：取號 session、取號結果、號碼頁的 store 都帶 demo:true", async () => {
    const s = await demoStore({ push: true, demo: true });
    const sess = await custSession(s);
    expect(sess.store).toMatchObject({ id: s.storeId, demo: true });
    const take: any = await (
      await appAt.request(`/api/s/${s.code}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone: "0912345678", consent: true }),
      }, env)
    ).json();
    expect(take.store.demo).toBe(true);
    const me: any = await (await appAt.request("/api/tickets/me", { headers: { authorization: `Bearer ${take.ticketToken}` } }, env)).json();
    expect(me.store.demo).toBe(true);
  });

  it("一般門店：store 不出現 demo 鍵", async () => {
    const s = await demoStore({ push: true, demo: false, demoSimulate: true });
    const sess = await custSession(s);
    expect(sess.store).not.toHaveProperty("demo");
  });

  it("面板 hello 的 store.features 帶 demo（面板據此顯示浮水印）", async () => {
    const id = uniq("sim");
    const d = await openWs(id, { role: "display", deviceId: `${id}_d1` }, { ctx: ctxWith(id, { demo: true }) });
    const hello = await d.next(isType("hello"));
    expect(hello.data.store.features.demo).toBe(true);
    d.ws.close();
  });
});

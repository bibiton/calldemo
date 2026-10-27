/**
 * 排隊順序（ADR-042）：排序鍵一律 (sort_key, ord)。ord 是 DO 內單調遞增的入隊序號（存在 state 列，零額外寫入），
 * 不依賴 SQLite rowid（VACUUM 可能重編沒有 INTEGER PRIMARY KEY 的表的 rowid）。
 * 業主要求：同一毫秒取號，叫號順序＝取號順序，「前面還有幾位」與叫號順序完全一致。
 */
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import storeQueueSrc from "../src/do/store-queue.ts?raw";
import {
  isType,
  openWs,
  phone,
  staffCmd,
  storeCtx,
  stubFor,
  take,
  uniq,
  type TestSocket,
} from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";

const staffAuth = { role: "staff", staffId: "u1", deviceId: "sd1" };
const T = Date.UTC(2026, 9, 27, 4, 0, 0, 123); // 台北 12:00:00.123

const freeze = (id: string, t = T) =>
  runInDurableObject(stubFor(id), (i: StoreQueueDO) => i.setClock(() => t));
const noOf = (n: string) => Number(n.slice(1));

async function staff(id: string): Promise<TestSocket> {
  const s = await openWs(id, staffAuth);
  await s.next(isType("snapshot"));
  return s;
}

/** 連續 callNext n 次，回傳叫出的號碼。 */
async function callN(
  s: TestSocket,
  counterId: string,
  n: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = await staffCmd(s, "callNext", { counterId });
    expect(a.ok, `第 ${i + 1} 次 callNext：${JSON.stringify(a)}`).toBe(true);
    out.push(a.result.ticket.number);
  }
  return out;
}

const seqNumbers = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}${String(i + 1).padStart(3, "0")}`,
  );

describe("排隊順序（ADR-042）：同一毫秒取號", () => {
  it("1. 固定時鐘取 3 號 → 連續 callNext 依序叫出 A001、A002、A003", async () => {
    const id = uniq();
    await freeze(id);
    for (let i = 1; i <= 3; i++) await take(id, i);
    const s = await staff(id);
    expect(await callN(s, "c2", 3)).toEqual(["A001", "A002", "A003"]);
    s.ws.close();
  });

  for (const [label, fixed] of [
    ["2. 固定時鐘（全部同一毫秒）", true],
    ["3. 不固定時鐘", false],
  ] as const) {
    it(`${label}並發 200 張：ahead＝號碼−1；連續叫 200 次順序＝號碼遞增；中途 ahead 一致`, async () => {
      const id = uniq();
      if (fixed) await freeze(id);
      const res: any[] = await Promise.all(
        Array.from({ length: 200 }, (_, i) => take(id, i + 1)),
      );
      expect(res.every((r) => r.ok)).toBe(true);
      for (const r of res)
        expect(r.ticket.ahead, r.ticket.number).toBe(noOf(r.ticket.number) - 1);
      const byNo = new Map(res.map((r) => [r.ticket.number, r.ticket.id]));
      const s = await staff(id);
      const called: string[] = [];
      for (let k = 0; k < 4; k++) {
        called.push(...(await callN(s, "c2", 50)));
        // 抽查：還在等候的號碼，ahead＝號碼−1−已叫數
        for (const no of [called.length + 1, called.length + 25, 200].filter(
          (x) => x <= 200 && x > called.length,
        )) {
          const num = `A${String(no).padStart(3, "0")}`;
          const v: any = await stubFor(id).ticketView(
            storeCtx(id),
            byNo.get(num)!,
          );
          expect(v.ahead, `${num} 在叫了 ${called.length} 號後`).toBe(
            no - 1 - called.length,
          );
        }
      }
      expect(called).toEqual(seqNumbers("A", 200));
      s.ws.close();
    });
  }

  it("4. 混合 A／B 同毫秒並發：各類別內順序正確、互不干擾；專屬櫃台只叫自己的類別；共用櫃台依入隊順序", async () => {
    const id = uniq();
    await freeze(id);
    const res: any[] = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        take(id, i + 1, { serviceId: i % 2 ? "svc_b" : "svc_a" }),
      ),
    );
    expect(res.every((r) => r.ok)).toBe(true);
    for (const r of res)
      expect(r.ticket.ahead, r.ticket.number).toBe(noOf(r.ticket.number) - 1);
    // 入隊順序（DO 內 ord）：共用櫃台 c2 應依此順序叫
    const order: string[] = await runInDurableObject(
      stubFor(id),
      (_i: StoreQueueDO, st) =>
        st.storage.sql
          .exec<{ number: string }>(
            "SELECT number FROM tickets WHERE status='waiting' ORDER BY sort_key, ord",
          )
          .toArray()
          .map((x) => x.number),
    );
    expect(order.filter((n) => n.startsWith("A"))).toEqual(seqNumbers("A", 60));
    expect(order.filter((n) => n.startsWith("B"))).toEqual(seqNumbers("B", 60));
    const s = await staff(id);
    // c1 只服務 A、c3 只服務 B：互不干擾
    expect(await callN(s, "c1", 10)).toEqual(seqNumbers("A", 10));
    expect(await callN(s, "c3", 10)).toEqual(seqNumbers("B", 10));
    // B 類別的等候人數只算 B
    const b20 = res.find((r) => r.ticket.number === "B020")!;
    expect(
      ((await stubFor(id).ticketView(storeCtx(id), b20.ticket.id)) as any)
        .ahead,
    ).toBe(9);
    // c2 服務全部：依剩下的入隊順序
    const rest = order.filter(
      (n) =>
        !seqNumbers("A", 10).includes(n) && !seqNumbers("B", 10).includes(n),
    );
    expect(await callN(s, "c2", 20)).toEqual(rest.slice(0, 20));
    s.ws.close();
  });

  it("5a. 重新排隊（隊尾）與新取號同一毫秒：誰先發生誰在前", async () => {
    const id = uniq();
    await freeze(id);
    await take(id, 1);
    await take(id, 2);
    const s = await staff(id);
    const t1 = (await staffCmd(s, "callNext", { counterId: "c2" })).result
      .ticket; // A001
    await staffCmd(s, "skip", { ticketId: t1.id });
    await take(id, 3); // A003：在 A001 重新排隊「之前」取號
    expect(
      (await staffCmd(s, "requeue", { ticketId: t1.id, position: "tail" })).ok,
    ).toBe(true);
    await take(id, 4); // A004：在 A001 重新排隊「之後」取號
    const v1: any = await stubFor(id).ticketView(storeCtx(id), t1.id);
    expect(v1.ahead).toBe(2); // A002、A003
    expect(await callN(s, "c2", 4)).toEqual(["A002", "A003", "A001", "A004"]);
    s.ws.close();
  });

  it("5b. 重新排隊（原位）回到原取號位置，即使與他人同一毫秒取號", async () => {
    const id = uniq();
    await freeze(id);
    for (let i = 1; i <= 3; i++) await take(id, i);
    const s = await staff(id);
    const t1 = (await staffCmd(s, "callNext", { counterId: "c2" })).result
      .ticket;
    await staffCmd(s, "skip", { ticketId: t1.id });
    await take(id, 4);
    await staffCmd(s, "requeue", { ticketId: t1.id, position: "original" });
    expect(
      ((await stubFor(id).ticketView(storeCtx(id), t1.id)) as any).ahead,
    ).toBe(0);
    expect(await callN(s, "c2", 4)).toEqual(["A001", "A002", "A003", "A004"]);
    s.ws.close();
  });

  it("5c. 重叫不改變任何人的排隊位置；面板近期叫號以「最後一次叫」排最前（同毫秒也一致）", async () => {
    const id = uniq();
    await freeze(id);
    for (let i = 1; i <= 4; i++) await take(id, i);
    const s = await staff(id);
    const a1 = (await staffCmd(s, "callNext", { counterId: "c1" })).result
      .ticket; // A001 @c1
    const a2 = (await staffCmd(s, "callNext", { counterId: "c2" })).result
      .ticket; // A002 @c2（同一毫秒）
    const a5: any = await take(id, 5);
    await staffCmd(s, "recall", { ticketId: a1.id }); // 同一毫秒重叫 A001
    expect(
      ((await stubFor(id).ticketView(storeCtx(id), a5.ticket.id)) as any).ahead,
    ).toBe(2); // A003、A004
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    const snap = await d.next(isType("snapshot"));
    expect(snap.data.recent.map((t: any) => t.number)).toEqual([
      "A001",
      "A002",
    ]);
    expect(a2.number).toBe("A002");
    expect(await callN(s, "c2", 3)).toEqual(["A003", "A004", "A005"]);
    s.ws.close();
    d.ws.close();
  });

  it("5d. 轉櫃台保留原排隊位置（只換服務／指定櫃台）", async () => {
    const id = uniq();
    await freeze(id);
    for (let i = 1; i <= 3; i++) await take(id, i);
    const s = await staff(id);
    const t1 = (await staffCmd(s, "callNext", { counterId: "c2" })).result
      .ticket;
    await staffCmd(s, "transfer", { ticketId: t1.id, toCounterId: "c2" });
    expect(await callN(s, "c2", 3)).toEqual(["A001", "A002", "A003"]);
    s.ws.close();
  });

  it("6a. 不依賴 rowid：把兩張等候中號碼的 rowid 對調（模擬 VACUUM 重編），叫號與 ahead 不變", async () => {
    const id = uniq();
    await freeze(id);
    const ts: any[] = [];
    for (let i = 1; i <= 3; i++) ts.push(await take(id, i));
    await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => {
      const sql = st.storage.sql;
      const r1 = sql
        .exec<{
          r: number;
        }>("SELECT rowid AS r FROM tickets WHERE number='A001'")
        .one().r;
      const r3 = sql
        .exec<{
          r: number;
        }>("SELECT rowid AS r FROM tickets WHERE number='A003'")
        .one().r;
      sql.exec("UPDATE tickets SET rowid=? WHERE number='A001'", 100000);
      sql.exec("UPDATE tickets SET rowid=? WHERE number='A003'", r1);
      sql.exec("UPDATE tickets SET rowid=? WHERE number='A001'", r3);
    });
    for (const [i, t] of ts.entries())
      expect(
        ((await stubFor(id).ticketView(storeCtx(id), t.ticket.id)) as any)
          .ahead,
      ).toBe(i);
    const s = await staff(id);
    expect(await callN(s, "c2", 3)).toEqual(["A001", "A002", "A003"]);
    s.ws.close();
  });

  it("6b. 刪除最大列（歸檔）後再取號：新號碼仍排在所有既有號碼之後", async () => {
    const id = uniq();
    await freeze(id);
    for (let i = 1; i <= 3; i++) await take(id, i);
    const last: any = await take(id, 4);
    await stubFor(id).cancelTicket(storeCtx(id), last.ticket.id);
    await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) =>
      st.storage.sql.exec("DELETE FROM tickets WHERE number='A004'"),
    );
    const n5: any = await take(id, 5);
    expect(n5.ticket.ahead).toBe(3);
    const s = await staff(id);
    expect(await callN(s, "c2", 4)).toEqual(["A001", "A002", "A003", "A005"]);
    s.ws.close();
  });

  it("6c. ord 存在既有 state 列：取號不新增任何 meta 列", async () => {
    const id = uniq();
    await freeze(id);
    await take(id, 1);
    const keys1 = await runInDurableObject(
      stubFor(id),
      (_i: StoreQueueDO, st) =>
        st.storage.sql.exec("SELECT key FROM meta ORDER BY key").toArray(),
    );
    await take(id, 2);
    await take(id, 3);
    const after = await runInDurableObject(
      stubFor(id),
      (_i: StoreQueueDO, st) => ({
        keys: st.storage.sql
          .exec("SELECT key FROM meta ORDER BY key")
          .toArray(),
        state: JSON.parse(
          st.storage.sql
            .exec<{ value: string }>("SELECT value FROM meta WHERE key='state'")
            .one().value,
        ),
        ords: st.storage.sql
          .exec<{ ord: number }>("SELECT ord FROM tickets ORDER BY no")
          .toArray()
          .map((x) => x.ord),
      }),
    );
    expect(after.keys).toEqual(keys1);
    expect(after.ords).toEqual([...after.ords].sort((a, b) => a - b));
    expect(new Set(after.ords).size).toBe(3);
    expect(after.state.ord).toBe(Math.max(...after.ords));
  });

  it("6d. 人員端／門店後台拿到的號碼帶排序鍵（sortKey、ord），隊尾重排後順序正確", async () => {
    const id = uniq();
    await freeze(id);
    await take(id, 1);
    await take(id, 2);
    const s = await staff(id);
    const t1 = (await staffCmd(s, "callNext", { counterId: "c2" })).result
      .ticket;
    await staffCmd(s, "skip", { ticketId: t1.id });
    const rq = await staffCmd(s, "requeue", {
      ticketId: t1.id,
      position: "tail",
    });
    expect(typeof rq.result.ticket.sortKey).toBe("number");
    expect(typeof rq.result.ticket.ord).toBe("number");
    const s2 = await staff(id);
    s2.send({ t: "resync" });
    const snap = await s2.next(isType("snapshot"));
    expect(snap.data.staff.waiting.map((t: any) => t.number)).toEqual([
      "A002",
      "A001",
    ]);
    const [a2, a1] = snap.data.staff.waiting;
    expect(
      a2.sortKey < a1.sortKey || (a2.sortKey === a1.sortKey && a2.ord < a1.ord),
    ).toBe(true);
    s.ws.close();
    s2.ws.close();
  });

  it("6e. 原始碼檢查：所有排隊排序都用 (sort_key, ord)；不以 rowid、號碼字串或只用 sort_key 排序", () => {
    const code = storeQueueSrc
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\browid\b/);
    expect(code).not.toMatch(/ORDER BY\s+(no|number)\b/i);
    for (const m of code.matchAll(/ORDER BY\s+sort_key\b([^`"]*)/gi))
      expect(m[1]).toMatch(/^\s*,\s*ord\b/);
    // 「前面幾位」子查詢也用 (sort_key, ord)
    expect(code).toMatch(/sort_key < \? OR \(sort_key = \? AND ord < \?\)/);
    // 面板近期叫號／櫃台目前號碼：同毫秒以叫號序（call_seq）決定
    for (const m of code.matchAll(/ORDER BY\s+called_at\s+DESC([^`"]*)/gi))
      expect(m[1]).toMatch(/^\s*,\s*call_seq DESC/);
  });
});

describe("T1 補強：並發取號號碼與手機一一對應", () => {
  it("200 張號碼各自對應正確的顧客（不串號）", async () => {
    const id = uniq();
    const res: any[] = await Promise.all(
      Array.from({ length: 200 }, (_, i) => take(id, i + 1)),
    );
    const rows = await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) =>
      st.storage.sql
        .exec<{ id: string; phone: string }>("SELECT id, phone FROM tickets")
        .toArray(),
    );
    const ph = new Map(rows.map((r) => [r.id, r.phone]));
    res.forEach((r, i) => expect(ph.get(r.ticket.id)).toBe(phone(i + 1)));
  });
});

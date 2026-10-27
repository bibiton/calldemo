import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { phone, stubFor, storeCtx, take, uniq } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";

describe("T1 並發取號不重號", () => {
  it("同一 DO 並發 200 個 takeTicket → 1..200 連續、無重複、無缺號", async () => {
    const id = uniq();
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => take(id, i)));
    expect(res.every((r) => r.ok)).toBe(true);
    const nos = res.map((r: any) => Number(r.ticket.number.slice(1))).sort((a, b) => a - b);
    expect(nos).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
  it("不同服務類別各自編號", async () => {
    const id = uniq();
    const a = await take(id, 1);
    const b = await take(id, 2, { serviceId: "svc_b" });
    expect((a as any).ticket.number).toBe("A001");
    expect((b as any).ticket.number).toBe("B001");
  });
});

describe("取號驗證", () => {
  it("不存在的服務 → 422", async () => {
    const r: any = await take(uniq(), 1, { serviceId: "nope" });
    expect(r).toMatchObject({ ok: false, status: 422, code: "SERVICE_INVALID" });
  });
  it("停用中的門店 → 403", async () => {
    const id = uniq();
    const r: any = await stubFor(id).takeTicket(storeCtx(id, {}, { status: "suspended" }), {
      jti: "x",
      serviceId: "svc_a",
      name: "王",
      phone: phone(1),
    });
    expect(r).toMatchObject({ ok: false, status: 403, code: "STORE_SUSPENDED" });
  });
});

describe("T8 取號 session 單次", () => {
  it("同 session 取第二張（不同資料）→ 409 SESSION_USED", async () => {
    const id = uniq();
    const first: any = await take(id, 1, { jti: "same" });
    expect(first.ok).toBe(true);
    const second: any = await take(id, 2, { jti: "same" });
    expect(second).toMatchObject({ ok: false, status: 409, code: "SESSION_USED" });
  });
  it("同 session、同一人重送（網路重試）→ 回原號碼，不新增", async () => {
    const id = uniq();
    const first: any = await take(id, 1, { jti: "same" });
    const again: any = await take(id, 1, { jti: "same" });
    expect(again.ok).toBe(true);
    expect(again.ticket.id).toBe(first.ticket.id);
    expect(again.existing).toBe(true);
  });
});

describe("T9 同手機重複取號", () => {
  it("同手機＋同姓名 → 回傳原號碼", async () => {
    const id = uniq();
    const a: any = await take(id, 1);
    const b: any = await take(id, 1, { jti: "other" });
    expect(b.ok).toBe(true);
    expect(b.existing).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
  });
  it("同手機、不同姓名 → 409 PHONE_ACTIVE", async () => {
    const id = uniq();
    await take(id, 1);
    const b: any = await take(id, 1, { jti: "other", name: "別人" });
    expect(b).toMatchObject({ ok: false, status: 409, code: "PHONE_ACTIVE" });
  });
  it("前一張已結束 → 同手機可再取新號", async () => {
    const id = uniq();
    const a: any = await take(id, 1);
    await stubFor(id).cancelTicket(storeCtx(id), a.ticket.id);
    const b: any = await take(id, 1, { jti: "other" });
    expect(b.ok).toBe(true);
    expect(b.existing).toBe(false);
    expect(b.ticket.number).toBe("A002");
  });
});

describe("T5 每日歸零（門店時區）", () => {
  const setClock = (id: string, t: number) =>
    runInDurableObject(stubFor(id), (inst: StoreQueueDO) => inst.setClock(() => t));

  it("跨台灣午夜後取號從 001 起", async () => {
    const id = uniq();
    await setClock(id, Date.UTC(2026, 9, 27, 15, 50)); // 台北 10/27 23:50
    await take(id, 1);
    const b: any = await take(id, 2);
    expect(b.ticket.number).toBe("A002");
    await setClock(id, Date.UTC(2026, 9, 27, 16, 5)); // 台北 10/28 00:05
    const c: any = await take(id, 3);
    expect(c.ticket.number).toBe("A001");
  });

  it("跨 UTC 午夜但未跨台灣午夜 → 不歸零", async () => {
    const id = uniq();
    await setClock(id, Date.UTC(2026, 9, 27, 23, 50)); // 台北 10/28 07:50
    await take(id, 1);
    await setClock(id, Date.UTC(2026, 9, 28, 0, 10)); // 台北 10/28 08:10
    const b: any = await take(id, 2);
    expect(b.ticket.number).toBe("A002");
  });
});

describe("T6 關店 Alarm", () => {
  it("未結束號碼轉 no_show、個資原文清空、q-history 收到批次、用量小時桶送出", async () => {
    const id = uniq();
    const stub = stubFor(id);
    await runInDurableObject(stub, (inst: StoreQueueDO) => {
      inst.setClock(() => Date.UTC(2026, 9, 27, 4, 0)); // 台北 12:00
      inst.captureHistory = true;
    });
    const a: any = await take(id, 1);
    await take(id, 2);
    await stub.cancelTicket(storeCtx(id), a.ticket.id);
    const alarmAt = await runInDurableObject(stub, (_i: StoreQueueDO, st) => st.storage.getAlarm());
    expect(alarmAt).toBe(Date.UTC(2026, 9, 27, 16, 29)); // 無營業時間設定 → 23:59 + 30 分（台北）
    await runInDurableObject(stub, (inst: StoreQueueDO) => inst.setClock(() => Date.UTC(2026, 9, 27, 16, 30)));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const r = await runInDurableObject(stub, (inst: StoreQueueDO, st) => ({
      rows: st.storage.sql.exec("SELECT status, name, phone, flushed FROM tickets ORDER BY no").toArray(),
      sent: inst.captured,
    }));
    expect(r.rows.map((x: any) => x.status)).toEqual(["cancelled", "no_show"]);
    expect(r.rows.every((x: any) => x.name === null && x.phone === null)).toBe(true);
    expect(r.rows.every((x: any) => x.flushed === 1)).toBe(true);
    const rows = r.sent.flatMap((m: any) => m.rows);
    expect(rows.map((x: any) => x.final_status).sort()).toEqual(["cancelled", "no_show"]);
    expect(r.sent.some((m: any) => m.usage.length > 0)).toBe(true);
  });

  it("營業時間有設定時，alarm 在關店後 30 分", async () => {
    const id = uniq();
    const stub = stubFor(id);
    await runInDurableObject(stub, (inst: StoreQueueDO) => inst.setClock(() => Date.UTC(2026, 9, 27, 4, 0)));
    const ctx = storeCtx(id, { businessHours: [{ dow: 2, open: "11:00", close: "21:30" }] });
    await stub.takeTicket(ctx, { jti: "j", serviceId: "svc_a", name: "王小明", phone: phone(1) });
    const alarmAt = await runInDurableObject(stub, (_i: StoreQueueDO, st) => st.storage.getAlarm());
    expect(alarmAt).toBe(Date.UTC(2026, 9, 27, 14, 0)); // 台北 22:00
  });

  it("滿 25 筆已結束即送一包（不等關店）", async () => {
    const id = uniq();
    const stub = stubFor(id);
    await runInDurableObject(stub, (inst: StoreQueueDO) => (inst.captureHistory = true));
    for (let i = 0; i < 25; i++) {
      const t: any = await take(id, i);
      await stub.cancelTicket(storeCtx(id), t.ticket.id);
    }
    const sent = await runInDurableObject(stub, (inst: StoreQueueDO) => inst.captured);
    expect(sent.length).toBe(1);
    expect(sent[0].rows.length).toBe(25);
  });
});

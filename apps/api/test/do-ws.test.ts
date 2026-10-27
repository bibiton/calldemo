import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { cmdId, isAck, isType, openWs, staffCmd, storeCtx, stubFor, take, uniq } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";

const staffAuth = { role: "staff", staffId: "u1", deviceId: "sd1" };

describe("hello／snapshot", () => {
  it("display 收到 hello（含 qr）與 snapshot（無個資）", async () => {
    const id = uniq();
    await take(id, 1);
    const s = await openWs(id, { role: "display", deviceId: "d1" });
    const hello = await s.next(isType("hello"));
    expect(hello.data.qr.keyVersion).toBe(1);
    expect(hello.data.store.name).toBe("測試店");
    const snap = await s.next(isType("snapshot"));
    expect(snap.data.waiting).toEqual({ svc_a: 1, svc_b: 0 });
    expect(JSON.stringify(snap)).not.toContain("顧客1");
    expect(JSON.stringify(snap)).not.toContain("0910000001");
    s.ws.close();
  });
  it("staff 的 hello 不含 qr；snapshot 含姓名與遮罩手機", async () => {
    const id = uniq();
    await take(id, 1);
    const s = await openWs(id, staffAuth);
    const hello = await s.next(isType("hello"));
    expect(hello.data.qr).toBeUndefined();
    const snap = await s.next(isType("snapshot"));
    expect(snap.data.staff.waiting[0]).toMatchObject({ name: "顧客1", phoneMasked: "0910***001", number: "A001" });
    expect(JSON.stringify(snap)).not.toContain("0910000001");
    s.ws.close();
  });
  it("customer 只拿到自己的號碼與前面人數", async () => {
    const id = uniq();
    await take(id, 1);
    const t2: any = await take(id, 2);
    const s = await openWs(id, { role: "customer", ticketId: t2.ticket.id });
    const snap = await s.next(isType("snapshot"));
    expect(snap.data.mine).toMatchObject({ number: "A002", ahead: 1, status: "waiting" });
    expect(snap.data.staff).toBeUndefined();
    s.ws.close();
  });
});

describe("人員指令（狀態機＋ack）", () => {
  it("callNext 叫最早的號、廣播給 display、ack 帶 seq", async () => {
    const id = uniq();
    await take(id, 1);
    await take(id, 2);
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    await d.next(isType("snapshot"));
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const ack = await staffCmd(s, "callNext", { counterId: "c1" });
    expect(ack.ok).toBe(true);
    expect(ack.result.ticket.number).toBe("A001");
    expect(typeof ack.seq).toBe("number");
    const ev = await d.next(isType("ticket.called"));
    expect(ev.data).toMatchObject({ number: "A001", counterNo: 1, recallCount: 0 });
    expect(ev.data.name).toBeUndefined();
    const sev = await s.next(isType("ticket.called"));
    expect(sev.data.name).toBe("顧客1");
    d.ws.close();
    s.ws.close();
  });

  it("櫃台只叫自己可服務的類別；隊列空 → QUEUE_EMPTY", async () => {
    const id = uniq();
    await take(id, 1, { serviceId: "svc_b" });
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    expect(await staffCmd(s, "callNext", { counterId: "c1" })).toMatchObject({ ok: false, error: "QUEUE_EMPTY" });
    expect((await staffCmd(s, "callNext", { counterId: "c3" })).result.ticket.number).toBe("B001");
    s.ws.close();
  });

  it("T11 同 cmdId 送 callNext 兩次 → 只叫一號、第二次 ack 回原結果", async () => {
    const id = uniq();
    await take(id, 1);
    await take(id, 2);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const cid = cmdId();
    const a1 = await staffCmd(s, "callNext", { counterId: "c1" }, cid);
    const a2 = await staffCmd(s, "callNext", { counterId: "c1" }, cid);
    expect(a2).toEqual(a1);
    const called = await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) =>
      st.storage.sql.exec("SELECT count(*) AS n FROM tickets WHERE status='called'").one(),
    );
    expect(called.n).toBe(1);
    s.ws.close();
  });

  it("完整流程：recall → startServing → finish；callNext 自動結束櫃台上一號", async () => {
    const id = uniq();
    await take(id, 1);
    await take(id, 2);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const t1 = (await staffCmd(s, "callNext", { counterId: "c2" })).result.ticket;
    const re = await staffCmd(s, "recall", { ticketId: t1.id });
    expect(re.result.ticket.recallCount).toBe(1);
    expect((await staffCmd(s, "startServing", { ticketId: t1.id })).result.ticket.status).toBe("serving");
    const t2 = (await staffCmd(s, "callNext", { counterId: "c2" })).result.ticket;
    expect(t2.number).toBe("A002");
    const st = await runInDurableObject(stubFor(id), (_i: StoreQueueDO, state) =>
      state.storage.sql.exec("SELECT status FROM tickets WHERE id=?", t1.id).one(),
    );
    expect(st.status).toBe("done");
    expect((await staffCmd(s, "finish", { ticketId: t2.id })).result.ticket.status).toBe("done");
    expect(await staffCmd(s, "finish", { ticketId: t2.id })).toMatchObject({ ok: false, error: "BAD_STATE" });
    s.ws.close();
  });

  it("skip → requeue(tail) 排到隊尾；noShow 為終態", async () => {
    const id = uniq();
    await take(id, 1);
    await take(id, 2);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const t1 = (await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket;
    expect((await staffCmd(s, "skip", { ticketId: t1.id })).result.ticket.status).toBe("skipped");
    expect((await staffCmd(s, "requeue", { ticketId: t1.id, position: "tail" })).result.ticket.status).toBe("waiting");
    expect((await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket.number).toBe("A002");
    const again = (await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket;
    expect(again.number).toBe("A001");
    expect((await staffCmd(s, "noShow", { ticketId: again.id })).result.ticket.status).toBe("no_show");
    s.ws.close();
  });

  it("requeue(original) 排回原位置", async () => {
    const id = uniq();
    await take(id, 1);
    await take(id, 2);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const t1 = (await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket;
    await staffCmd(s, "skip", { ticketId: t1.id });
    await staffCmd(s, "requeue", { ticketId: t1.id, position: "original" });
    expect((await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket.number).toBe("A001");
    s.ws.close();
  });

  it("transfer 到指定櫃台：只有該櫃台叫得到；transferCount+1", async () => {
    const id = uniq();
    await take(id, 1);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const t1 = (await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket;
    const tr = await staffCmd(s, "transfer", { ticketId: t1.id, toCounterId: "c2" });
    expect(tr.result.ticket).toMatchObject({ status: "waiting", transferCount: 1 });
    expect(await staffCmd(s, "callNext", { counterId: "c1" })).toMatchObject({ ok: false, error: "QUEUE_EMPTY" });
    expect((await staffCmd(s, "callNext", { counterId: "c2" })).result.ticket.id).toBe(t1.id);
    s.ws.close();
  });

  it("transfer 換服務類別（號碼不變）", async () => {
    const id = uniq();
    await take(id, 1);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const t1 = (await staffCmd(s, "callNext", { counterId: "c1" })).result.ticket;
    await staffCmd(s, "transfer", { ticketId: t1.id, toServiceId: "svc_b" });
    expect((await staffCmd(s, "callNext", { counterId: "c3" })).result.ticket).toMatchObject({ number: "A001", serviceId: "svc_b" });
    s.ws.close();
  });

  it("call 指定叫號、createTicket 代客取號、revealPhone 回完整手機", async () => {
    const id = uniq();
    await take(id, 1);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const c = await staffCmd(s, "createTicket", { serviceId: "svc_a", name: "代取", phone: "0922-333-444" });
    expect(c.result.ticket).toMatchObject({ number: "A002", source: "staff" });
    const noPhone = await staffCmd(s, "createTicket", { serviceId: "svc_a" });
    expect(noPhone.result.ticket.number).toBe("A003");
    const call = await staffCmd(s, "call", { ticketId: c.result.ticket.id, counterId: "c2" });
    expect(call.result.ticket.status).toBe("called");
    const rv = await staffCmd(s, "revealPhone", { ticketId: c.result.ticket.id });
    expect(rv.result.phone).toBe("0922333444");
    expect(await staffCmd(s, "createTicket", { serviceId: "svc_a", phone: "0812345678" })).toMatchObject({ ok: false, error: "PHONE_INVALID" });
    s.ws.close();
  });

  it("非 staff 不能下指令", async () => {
    const id = uniq();
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    await d.next(isType("snapshot"));
    const cid = cmdId();
    d.send({ t: "cmd", cmdId: cid, cmd: "callNext", args: { counterId: "c1" } });
    expect(await d.next(isAck(cid))).toMatchObject({ ok: false, error: "FORBIDDEN" });
    d.ws.close();
  });
});

describe("customer 事件可見性與 queue.position", () => {
  it("只收自己的 ticket.called；別人被叫時收到 queue.position", async () => {
    const id = uniq();
    await take(id, 1);
    const t2: any = await take(id, 2);
    const c = await openWs(id, { role: "customer", ticketId: t2.ticket.id });
    await c.next(isType("snapshot"));
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" });
    const pos = await c.next(isType("queue.position"));
    expect(pos.data).toMatchObject({ ticketId: t2.ticket.id, ahead: 0 });
    expect(c.msgs.find((m) => m.type === "ticket.called")).toBeUndefined();
    await staffCmd(s, "callNext", { counterId: "c1" });
    const mine = await c.next(isType("ticket.called"));
    expect(mine.data).toMatchObject({ id: t2.ticket.id, counterNo: 1 });
    c.ws.close();
    s.ws.close();
  });
});

describe("T2 lastSeq 補推不漏不重", () => {
  it("斷線期間 30 個事件，帶 lastSeq 重連恰好收到這 30 個", async () => {
    const id = uniq();
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    const snap = await d.next(isType("snapshot"));
    const last = snap.seq;
    d.ws.close();
    for (let i = 0; i < 30; i++) await take(id, i);
    const d2 = await openWs(id, { role: "display", deviceId: "d1" }, { lastSeq: last });
    await d2.next(isType("hello"));
    await new Promise((r) => setTimeout(r, 200));
    const evts = d2.msgs.filter((m) => m.t === "evt" && m.type !== "hello");
    expect(evts.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => last + 1 + i));
    expect(evts.every((m) => m.type === "ticket.created")).toBe(true);
    d2.ws.close();
  });

  it("lastSeq 差距 > 200 → 改收 snapshot", async () => {
    const id = uniq();
    for (let i = 0; i < 205; i++) await take(id, i);
    const d = await openWs(id, { role: "display", deviceId: "d1" }, { lastSeq: 1 });
    await d.next(isType("hello"));
    const snap = await d.next(isType("snapshot"));
    expect(snap.seq).toBe(205);
    expect(d.msgs.filter((m) => m.type === "ticket.created").length).toBe(0);
    d.ws.close();
  });

  it("lastSeq 比保留的最舊事件還舊 → snapshot", async () => {
    const id = uniq();
    for (let i = 0; i < 3; i++) await take(id, i);
    await runInDurableObject(stubFor(id), (_i: StoreQueueDO, st) => st.storage.sql.exec("DELETE FROM events WHERE seq <= 2"));
    const d = await openWs(id, { role: "display", deviceId: "d1" }, { lastSeq: 0 });
    await d.next(isType("hello"));
    expect((await d.next(isType("snapshot"))).seq).toBe(3);
    d.ws.close();
  });

  it("customer 補推只收自己的事件", async () => {
    const id = uniq();
    const t: any = await take(id, 1);
    const c = await openWs(id, { role: "customer", ticketId: t.ticket.id }, { lastSeq: 0 });
    await c.next(isType("snapshot"));
    c.ws.close();
  });
});

describe("T3（DO 端）停用", () => {
  it("suspend → 已連線收到 store.suspended 並以 4003 關閉", async () => {
    const id = uniq();
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    await d.next(isType("snapshot"));
    await stubFor(id).suspend("suspended");
    const ev = await d.next(isType("store.suspended"));
    expect(ev.data.reason).toBe("suspended");
    expect(await d.closed).toBe(4003);
  });
  it("停用中的門店不接受新連線", async () => {
    const id = uniq();
    const res = await stubFor(id).fetch("https://do/ws", {
      headers: {
        Upgrade: "websocket",
        "x-qcs-ctx": encodeURIComponent(JSON.stringify(storeCtx(id, {}, { status: "suspended" }))),
        "x-qcs-auth": encodeURIComponent(JSON.stringify({ role: "display" })),
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("面板音訊狀態回報", () => {
  it("display 送 status → staff 收到 device.status；同狀態不重複廣播", async () => {
    const id = uniq();
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    const d = await openWs(id, { role: "display", deviceId: "d1" });
    await d.next(isType("snapshot"));
    d.send({ t: "status", audio: "blocked", client: "browser" });
    const ev = await s.next(isType("device.status"));
    expect(ev.data).toMatchObject({ deviceId: "d1", audio: "blocked" });
    d.send({ t: "status", audio: "blocked", client: "browser" });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.msgs.filter((m) => m.type === "device.status").length).toBe(0);
    s.ws.close();
    d.ws.close();
  });
});

describe("面板音訊狀態放進 staff snapshot（門店後台一開就看得到警示）", () => {
  it("面板回報 blocked 後，新連上的 staff snapshot.devices 帶 audio=blocked；display snapshot 不帶", async () => {
    const id = uniq();
    const d = await openWs(id, { role: "display", deviceId: "d9" });
    await d.next(isType("snapshot"));
    d.send({ t: "status", audio: "blocked", client: "browser" });
    const s0 = await openWs(id, staffAuth);
    await s0.next(isType("snapshot"));
    await s0.next(isType("device.status"));
    const s = await openWs(id, staffAuth);
    const snap = await s.next(isType("snapshot"));
    expect(snap.data.devices).toEqual([{ deviceId: "d9", audio: "blocked" }]);
    const d2 = await openWs(id, { role: "display", deviceId: "d8" });
    expect((await d2.next(isType("snapshot"))).data.devices).toBeUndefined();
    for (const x of [d, s0, s, d2]) x.ws.close();
  });
});

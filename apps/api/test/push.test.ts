import { describe, expect, it } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from "cloudflare:test";
import { b64urlEncode, qrWindow, computeQrToken, deriveStoreKey } from "@qcs/shared";
import { env } from "./test-env";
import { createApp } from "../src/app";
import { handlePushBatch, type PushMessage } from "../src/push-consumer";
import { isType, openWs, staffCmd, storeCtx, stubFor, take, uniq } from "./helpers";
import { seedStore } from "./fixtures";
import type { StoreQueueDO } from "../src/do/store-queue";

const staffAuth = { role: "staff", staffId: "u1", deviceId: "sd1" };

async function capture(id: string) {
  const stub = stubFor(id);
  await runInDurableObject(stub, (i: StoreQueueDO) => {
    i.capturePush = true;
    i.capturedPush = [];
  });
  return {
    stub,
    msgs: () => runInDurableObject(stub, (i: StoreQueueDO) => i.capturedPush.slice()),
  };
}

async function uaKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    p256dh: b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer)),
    auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

describe("推播觸發（DO → q-push，只在顧客沒開著 WS 時）", () => {
  it("已訂閱、頁面不在前景：叫到號 → 1 則 called（號碼、櫃台）；未訂閱者不送", async () => {
    const id = uniq();
    const q = await capture(id);
    const t1: any = await take(id, 1);
    await take(id, 2);
    expect((await q.stub.enablePush(storeCtx(id), t1.ticket.id)).ok).toBe(true);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" }); // 叫 A001（已訂閱）
    await staffCmd(s, "callNext", { counterId: "c2" }); // 叫 A002（未訂閱）
    const called = (await q.msgs()).filter((m) => m.t === "called");
    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({ kind: "push", storeId: id, ticketId: t1.ticket.id, n: "A001", c: 1 });
    s.ws.close();
  });

  it("顧客頁開著（有 ticket WS）→ 不送推播；關掉頁面後 → 改送推播", async () => {
    const id = uniq();
    const q = await capture(id);
    const t: any = await take(id, 1);
    await q.stub.enablePush(storeCtx(id), t.ticket.id);
    const c = await openWs(id, { role: "customer", ticketId: t.ticket.id });
    await c.next(isType("snapshot"));
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" });
    await c.next(isType("ticket.called"));
    expect((await q.msgs()).filter((m) => m.t === "called")).toHaveLength(0);
    c.ws.close(1000);
    await c.closed;
    // 等 DO 處理 close
    await new Promise((r) => setTimeout(r, 50));
    await staffCmd(s, "recall", { ticketId: t.ticket.id });
    const after = (await q.msgs()).filter((m) => m.t === "called");
    expect(after).toHaveLength(1);
    expect(after[0].recall).toBe(1);
    s.ws.close();
  });

  it("前面剩 3 位（門店預設）→ 送一次 soon；之後隊伍再前進不重送", async () => {
    const id = uniq();
    const q = await capture(id);
    for (let i = 1; i <= 4; i++) await take(id, i);
    const t5: any = await take(id, 5); // 前面 4 位
    await q.stub.enablePush(storeCtx(id), t5.ticket.id);
    expect((await q.msgs()).filter((m) => m.t === "soon")).toHaveLength(0);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" }); // 前面剩 3
    let soon = (await q.msgs()).filter((m) => m.t === "soon");
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({ ticketId: t5.ticket.id, n: "A005", ahead: 3 });
    await staffCmd(s, "callNext", { counterId: "c1" }); // 前面剩 2
    soon = (await q.msgs()).filter((m) => m.t === "soon");
    expect(soon).toHaveLength(1);
    s.ws.close();
  });

  it("門店設定 notifyAhead=1 → 前面剩 1 位才送", async () => {
    const id = uniq();
    const q = await capture(id);
    const ctx = storeCtx(id, { notifyAhead: 1 } as any);
    await q.stub.summary(ctx);
    for (let i = 1; i <= 2; i++) await take(id, i);
    const t3: any = await take(id, 3);
    await q.stub.enablePush(ctx, t3.ticket.id);
    const s = await openWs(id, staffAuth, { ctx });
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" }); // 剩 1
    expect((await q.msgs()).filter((m) => m.t === "soon").map((m) => m.ahead)).toEqual([1]);
    s.ws.close();
  });

  it("過號 → skipped；已結束的號碼不能再訂閱", async () => {
    const id = uniq();
    const q = await capture(id);
    const t: any = await take(id, 1);
    await q.stub.enablePush(storeCtx(id), t.ticket.id);
    const s = await openWs(id, staffAuth);
    await s.next(isType("snapshot"));
    await staffCmd(s, "callNext", { counterId: "c1" });
    await staffCmd(s, "skip", { ticketId: t.ticket.id });
    expect((await q.msgs()).map((m) => m.t)).toEqual(["called", "skipped"]);
    await staffCmd(s, "noShow", { ticketId: t.ticket.id });
    expect(await q.stub.enablePush(storeCtx(id), t.ticket.id)).toMatchObject({ ok: false, code: "TICKET_ENDED" });
    s.ws.close();
  });
});

describe("訂閱 API：POST /api/tickets/:id/push", () => {
  const app = createApp();
  async function ticketFor() {
    const s = await seedStore();
    const now = Date.now();
    const key = await deriveStoreKey(env.QR_ROOT_SECRET, s.storeId, 1);
    const w = qrWindow(now);
    const sess: any = await (await app.request(`/api/s/${s.code}/session?w=${w}&k=${await computeQrToken(key, s.storeId, w)}`, {}, env)).json();
    expect(sess.push.publicKey).toBe(env.VAPID_PUBLIC_KEY);
    const r: any = await (
      await app.request(
        `/api/s/${s.code}/tickets`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sess.sessionToken, serviceId: `${s.storeId}_A`, name: "王小明", phone: "0912345678", consent: true }) },
        env,
      )
    ).json();
    return { s, ticket: r.ticket, token: r.ticketToken as string };
  }
  const post = (path: string, token: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, env);

  it("合法訂閱 → 寫入 D1（一號一筆，重送覆蓋）", async () => {
    const { ticket, token, s } = await ticketFor();
    const keys = await uaKeys();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys };
    expect((await post(`/api/tickets/${ticket.id}/push`, token, sub)).status).toBe(200);
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/def" })).status).toBe(200);
    const rows = (await env.DB.prepare("SELECT * FROM push_subscriptions WHERE ticket_id=?").bind(ticket.id).all()).results as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: s.storeId, endpoint: "https://fcm.googleapis.com/fcm/send/def", p256dh: keys.p256dh, auth: keys.auth });
  });

  it("格式錯誤 → 422；別人的號碼 → 403；沒有 token → 401", async () => {
    const { ticket, token } = await ticketFor();
    const keys = await uaKeys();
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { endpoint: "ftp://x/y", keys })).status).toBe(422);
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { endpoint: "https://x.example/y", keys: { ...keys, p256dh: "AAAA" } })).status).toBe(422);
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { endpoint: "https://x.example/y", keys: { ...keys, auth: "AAAA" } })).status).toBe(422);
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { endpoint: "https://x.example/" + "a".repeat(2000), keys })).status).toBe(422);
    expect((await post(`/api/tickets/other/push`, token, { endpoint: "https://x.example/y", keys })).status).toBe(403);
    expect((await app.request(`/api/tickets/${ticket.id}/push`, { method: "POST", body: "{}" }, env)).status).toBe(401);
  });

  it("非 local 環境只接受 https endpoint", async () => {
    const { ticket, token } = await ticketFor();
    const keys = await uaKeys();
    const staging = { ...env, ENV: "staging" as const, DEV_BYPASS_ACCESS: undefined };
    const r = await app.request(
      `/api/tickets/${ticket.id}/push`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ endpoint: "http://127.0.0.1:9/p", keys }) },
      staging,
    );
    expect(r.status).toBe(422);
  });

  it("門店關閉推播功能（features.push=false）→ session 不給公鑰、訂閱 403", async () => {
    const { s, ticket, token } = await ticketFor();
    await env.DB.prepare("UPDATE stores SET features='{\"push\":false}', updated_at=updated_at+1 WHERE id=?").bind(s.storeId).run();
    const { refreshStore } = await import("../src/lib/store-ctx");
    await refreshStore(env, s.storeId);
    const keys = await uaKeys();
    expect((await post(`/api/tickets/${ticket.id}/push`, token, { endpoint: "https://x.example/y", keys })).status).toBe(403);
  });
});

describe("q-push consumer（createMessageBatch）", () => {
  async function seedSub(endpoint: string) {
    const ticketId = uniq("tk");
    const keys = await uaKeys();
    await env.DB.prepare("INSERT INTO push_subscriptions(ticket_id,store_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)")
      .bind(ticketId, "st_x", endpoint, keys.p256dh, keys.auth, Date.now())
      .run();
    return ticketId;
  }
  const msg = (ticketId: string, t: PushMessage["t"] = "called", attempts = 1, id = uniq("m")) => ({
    id,
    timestamp: new Date(),
    attempts,
    body: { kind: "push", storeId: "st_x", ticketId, t, n: "A023", c: 2, ahead: 0, recall: 0, at: Date.now() } satisfies PushMessage,
  });
  const fake = (status: number, headers: Record<string, string> = {}) => {
    const seen: Request[] = [];
    return { seen, fetch: async (r: Request) => (seen.push(r), new Response(null, { status, headers })) };
  };
  async function run(messages: any[], f: { fetch: (r: Request) => Promise<Response> }) {
    const batch = createMessageBatch("qcs-push-local", messages);
    const ctx = createExecutionContext();
    const delays: Record<string, number | undefined> = {};
    const wrapped = {
      ...batch,
      queue: batch.queue,
      ackAll: () => batch.ackAll(),
      retryAll: (o?: any) => batch.retryAll(o),
      messages: batch.messages.map((m: any) => ({
        id: m.id,
        timestamp: m.timestamp,
        attempts: m.attempts,
        body: m.body,
        ack: () => m.ack(),
        retry: (o?: { delaySeconds?: number }) => {
          delays[m.id] = o?.delaySeconds;
          m.retry(o);
        },
      })),
    };
    await handlePushBatch(wrapped as any, env, { fetch: f.fetch as any });
    const r = await getQueueResult(batch, ctx);
    return { ...r, retryMessages: r.retryMessages.map((x: any) => ({ msgId: x.msgId, delaySeconds: delays[x.msgId] })) };
  }
  const subExists = async (id: string) => !!(await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE ticket_id=?").bind(id).first());

  it("201 → ack；請求帶 VAPID、aes128gcm、TTL 120、Urgency high", async () => {
    const id = await seedSub("https://push.example.com/a");
    const f = fake(201);
    const m = msg(id);
    const res = await run([m], f);
    expect(res.explicitAcks).toEqual([m.id]);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].headers.get("authorization")).toMatch(/^vapid t=.+, k=/);
    expect(f.seen[0].headers.get("ttl")).toBe("120");
    expect(f.seen[0].headers.get("urgency")).toBe("high");
    expect(await subExists(id)).toBe(true);
  });

  it("soon 的 TTL 為 300 秒", async () => {
    const id = await seedSub("https://push.example.com/b");
    const f = fake(201);
    await run([msg(id, "soon")], f);
    expect(f.seen[0].headers.get("ttl")).toBe("300");
  });

  it("404／410 → 刪除訂閱並 ack（不重試）", async () => {
    for (const status of [404, 410]) {
      const id = await seedSub("https://push.example.com/gone");
      const m = msg(id);
      const res = await run([m], fake(status));
      expect(res.explicitAcks).toEqual([m.id]);
      expect(res.retryMessages).toEqual([]);
      expect(await subExists(id)).toBe(false);
    }
  });

  it("429 → retry（依 Retry-After）；5xx → retry（指數退避）；訂閱保留", async () => {
    const id = await seedSub("https://push.example.com/busy");
    const m1 = msg(id);
    const r1 = await run([m1], fake(429, { "retry-after": "7" }));
    expect(r1.retryMessages).toEqual([{ msgId: m1.id, delaySeconds: 7 }]);
    const m2 = msg(id, "called", 2);
    const r2 = await run([m2], fake(503));
    expect(r2.retryMessages).toEqual([{ msgId: m2.id, delaySeconds: 10 }]);
    expect(await subExists(id)).toBe(true);
  });

  it("已重試 3 次仍失敗 → 放棄（ack），不再重試", async () => {
    const id = await seedSub("https://push.example.com/busy2");
    const m = msg(id, "called", 4);
    const res = await run([m], fake(500));
    expect(res.explicitAcks).toEqual([m.id]);
    expect(res.retryMessages).toEqual([]);
  });

  it("網路錯誤 → retry；沒有訂閱 → ack 且不送", async () => {
    const id = await seedSub("https://push.example.com/net");
    const m = msg(id);
    const res = await run([m], { fetch: async () => { throw new Error("ECONNRESET"); } });
    expect(res.retryMessages.map((x: any) => x.msgId)).toEqual([m.id]);
    const f = fake(201);
    const none = msg("no_such_ticket");
    const r2 = await run([none], f);
    expect(r2.explicitAcks).toEqual([none.id]);
    expect(f.seen).toHaveLength(0);
  });

  it("一批 25 則並行送出", async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, (_, i) => seedSub(`https://push.example.com/p${i}`)));
    let inflight = 0;
    let peak = 0;
    const f = {
      fetch: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        return new Response(null, { status: 201 });
      },
    };
    const res = await run(ids.map((id) => msg(id)), f);
    expect(res.explicitAcks).toHaveLength(25);
    expect(peak).toBeGreaterThan(1);
  });
});

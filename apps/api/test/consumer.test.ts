import { describe, expect, it } from "vitest";
import { env } from "./test-env";
import { createMessageBatch, createScheduledController, getQueueResult, createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import worker from "../src/index";
import { hmacSha256, toHex } from "@qcs/shared";
import { stubFor, storeCtx, take, uniq } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";
import { runRetention } from "../src/scheduled";

describe("T13 個資保存：q-history consumer 寫入 D1 的列", () => {
  it("無姓名／手機原文；name_masked、phone_masked、phone_hmac 正確；重送冪等", async () => {
    const id = uniq();
    const stub = stubFor(id);
    await runInDurableObject(stub, (inst: StoreQueueDO) => (inst.captureHistory = true));
    const t: any = await take(id, 0, { name: "王小明", phone: "0912345678" });
    await stub.cancelTicket(storeCtx(id), t.ticket.id);
    await runInDurableObject(stub, (inst: StoreQueueDO) => inst.setClock(() => Date.now() + 2 * 86400_000));
    await runDurableObjectAlarm(stub);
    const msgs = await runInDurableObject(stub, (inst: StoreQueueDO) => inst.captured);
    const body = msgs.find((m) => m.rows.length)!;
    expect(JSON.stringify(body)).not.toContain("王小明");
    expect(JSON.stringify(body)).not.toContain("0912345678");

    const batch = createMessageBatch("qcs-history-local", [{ id: "m1", timestamp: new Date(), attempts: 1, body }]);
    const ctx = createExecutionContext();
    await worker.queue(batch as any, env, ctx as any);
    const res = await getQueueResult(batch, ctx);
    expect(res.explicitAcks).toEqual(["m1"]);
    // 重送同一包 → INSERT OR IGNORE，不重複
    await worker.queue(createMessageBatch("qcs-history-local", [{ id: "m2", timestamp: new Date(), attempts: 1, body }]) as any, env, createExecutionContext() as any);

    const rows = (await env.DB.prepare("SELECT * FROM tickets_history WHERE store_id=?").bind(id).all()).results as any[];
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r).toMatchObject({ number: "A001", final_status: "cancelled", name_masked: "王○明", phone_masked: "0912***678" });
    expect(r.phone_hmac).toBe(toHex(await hmacSha256(env.PHONE_PEPPER, "0912345678")).slice(0, 32));
    expect(JSON.stringify(r)).not.toContain("王小明");
    expect(JSON.stringify(r)).not.toContain("0912345678");
  });

  it("pii.reveal 稽核經批次寫入 audit_logs，detail 不含原文", async () => {
    const body = {
      kind: "history",
      storeId: "st_x",
      rows: [],
      usage: [],
      audits: [{ id: uniq("a"), at: Date.now(), actor_type: "staff", actor_id: "u1", store_id: "st_x", action: "pii.reveal", target: "t1", detail: null }],
    };
    await worker.queue(createMessageBatch("qcs-history-local", [{ id: "a1", timestamp: new Date(), attempts: 1, body }]) as any, env, createExecutionContext() as any);
    const r = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE store_id='st_x'").first();
    expect(r).toMatchObject({ action: "pii.reveal", detail: null });
  });
});

describe("保留期限 Cron", () => {
  it("刪除 90 天前的歷史、24 小時前的推播訂閱", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tickets_history(id,store_id,business_date,service_id,number,final_status,created_at,ended_at) VALUES('old','s','2026-01-01','a','A001','done',0,?)").bind(now - 91 * 86400_000),
      env.DB.prepare("INSERT INTO tickets_history(id,store_id,business_date,service_id,number,final_status,created_at,ended_at) VALUES('new','s','2026-10-01','a','A002','done',0,?)").bind(now - 10 * 86400_000),
      env.DB.prepare("INSERT INTO push_subscriptions(ticket_id,store_id,endpoint,p256dh,auth,created_at) VALUES('p1','s','e','k','a',?)").bind(now - 25 * 3600_000),
    ]);
    const out = await runRetention(env, now);
    expect(out.tickets_history).toBe(1);
    expect(out.push_subscriptions).toBe(1);
    const left = (await env.DB.prepare("SELECT id FROM tickets_history").all()).results.map((r: any) => r.id);
    expect(left).toContain("new");
    expect(left).not.toContain("old");
  });
  it("scheduled handler 依 cron 觸發清理", async () => {
    const ctl = createScheduledController({ cron: "30 19 * * *", scheduledTime: Date.now() });
    await worker.scheduled(ctl, env, createExecutionContext() as any);
  });
});

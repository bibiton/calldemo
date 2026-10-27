/**
 * M0 0.2：本機 workerd 對 Hibernation、auto-response、alarm 的支援（結果寫進 docs/11-local-testing §1）。
 * M0 0.3：PBKDF2 iteration 上限（結果寫回 docs/06-auth）。
 */
import { describe, expect, it } from "vitest";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { isType, openWs, stubFor, uniq } from "./helpers";
import type { StoreQueueDO } from "../src/do/store-queue";
import { pbkdf2 } from "../src/lib/password";

describe("M0 0.2 hibernation／auto-response／alarm（本機 workerd）", () => {
  it("文字 ping 由 setWebSocketAutoResponse 回 pong，不進 webSocketMessage", async () => {
    const id = uniq();
    const s = await openWs(id, { role: "display", deviceId: "d1" });
    await s.next(isType("hello"));
    s.send("ping");
    expect(await s.next((m) => m === "pong")).toBe("pong");
    const r = await runInDurableObject(stubFor(id), (inst: StoreQueueDO, state) => ({
      handled: inst.debug.messagesHandled,
      ts: state.getWebSocketAutoResponseTimestamp(state.getWebSockets()[0]),
    }));
    expect(r.handled).toBe(0);
    expect(r.ts).toBeInstanceOf(Date);
    s.ws.close();
  });

  it("驅逐（hibernate）後連線仍在，下一則訊息喚醒 DO 並由 attachment 還原角色", async () => {
    const id = uniq();
    const stub = stubFor(id);
    const s = await openWs(id, { role: "staff", staffId: "u1", deviceId: "sd1" });
    await s.next(isType("hello"));
    await s.next(isType("snapshot"));
    const before = await runInDurableObject(stub, (inst: StoreQueueDO) => inst.debug.instanceId);
    await evictDurableObject(stub);
    s.send({ t: "resync" });
    const snap = await s.next(isType("snapshot"));
    expect(snap.data.staff).toBeDefined(); // staff 版 snapshot → 角色由 attachment 還原
    const after = await runInDurableObject(stub, (inst: StoreQueueDO) => inst.debug.instanceId);
    expect(after).not.toBe(before); // 確實是新的實例（喚醒）
    s.ws.close();
  });

  it("驅逐後 auto-response 仍回 pong", async () => {
    const id = uniq();
    const s = await openWs(id, { role: "display", deviceId: "d1" });
    await s.next(isType("hello"));
    await evictDurableObject(stubFor(id));
    s.send("ping");
    expect(await s.next((m) => m === "pong")).toBe("pong");
    s.ws.close();
  });

  it("storage.setAlarm 可由 runDurableObjectAlarm 觸發", async () => {
    const id = uniq();
    const stub = stubFor(id);
    await runInDurableObject(stub, (_i: StoreQueueDO, state) => state.storage.setAlarm(Date.now() + 3600_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe("M0 0.3 PBKDF2 iteration 上限（本機 workerd）", () => {
  const salt = new Uint8Array(16);
  it("100,000 次可用", async () => {
    expect((await pbkdf2("123456", salt, 100_000)).length).toBe(32);
  });
  // 實測結果（2026-10-27）：本機 workerd 不限制 iteration（100,001／600,000 都成功）。
  // 社群說的「production 上限 100,000」本機無法驗證 → 留待 staging（06-auth 已註記）；程式維持 100,000。
  it.each([100_001, 600_000])("本機 workerd 接受 %i 次（記錄行為，非保證 production）", async (n) => {
    const t0 = performance.now();
    expect((await pbkdf2("123456", salt, n)).length).toBe(32);
    console.log(`[M0 0.3] PBKDF2 ${n} iterations: ${(performance.now() - t0).toFixed(0)} ms (local workerd)`);
  });
});

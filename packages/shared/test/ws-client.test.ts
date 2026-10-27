import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QcsSocket, backoffDelay } from "../src/ws-client";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols?: string[]) {
    FakeWS.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(o: unknown) {
    this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) });
  }
}

const evt = (seq: number, type = "ticket.called") => ({ t: "evt", seq, at: Date.now(), type, data: {} });

describe("QcsSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (extra: Partial<ConstructorParameters<typeof QcsSocket>[0]> = {}) => {
    const got: unknown[] = [];
    const s = new QcsSocket({
      url: (lastSeq) => `ws://x/ws?lastSeq=${lastSeq ?? ""}`,
      protocols: () => ["qcs.v1"],
      WebSocketImpl: FakeWS as any,
      onMessage: (m) => got.push(m),
      random: () => 0.5,
      ...extra,
    });
    s.start();
    return { s, got };
  };

  it("每 30 秒送文字 ping；10 秒內沒 pong 就重連", () => {
    make();
    const ws = FakeWS.instances[0];
    ws.open();
    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toContain("ping");
    vi.advanceTimersByTime(10_001);
    expect(ws.readyState).toBe(3);
    vi.advanceTimersByTime(1_000);
    expect(FakeWS.instances.length).toBe(2);
  });

  it("收到 pong 就不重連", () => {
    make();
    const ws = FakeWS.instances[0];
    ws.open();
    vi.advanceTimersByTime(30_000);
    ws.recv("pong");
    vi.advanceTimersByTime(15_000);
    expect(FakeWS.instances.length).toBe(1);
  });

  it("重連帶 lastSeq；seq <= lastSeq 的事件丟棄", () => {
    const { got } = make();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv(evt(1));
    ws.recv(evt(2));
    ws.recv(evt(2));
    expect(got.length).toBe(2);
    ws.close(1006);
    vi.advanceTimersByTime(2_000);
    expect(FakeWS.instances[1].url).toContain("lastSeq=2");
  });

  it("跳號時送 resync（非 customer）", () => {
    make();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv(evt(1));
    ws.recv(evt(5));
    expect(ws.sent).toContain(JSON.stringify({ t: "resync" }));
  });

  it("customer 不做跳號檢查", () => {
    make({ gapCheck: false });
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv(evt(1));
    ws.recv(evt(5));
    expect(ws.sent).not.toContain(JSON.stringify({ t: "resync" }));
  });

  it("snapshot 會重設 lastSeq", () => {
    const { s } = make();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ t: "evt", type: "snapshot", seq: 40, at: Date.now(), data: {} });
    expect(s.lastSeq).toBe(40);
  });

  it("4003（停用）後不再重連", () => {
    make();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.close(4003);
    vi.advanceTimersByTime(120_000);
    expect(FakeWS.instances.length).toBe(1);
  });

  it("退避 1,2,4,8…最多 30 秒，±20% 抖動", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, () => 0.5)).toBe(2000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, () => 0.5)).toBe(30000);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1200);
    expect(backoffDelay(10, () => 0.5, 300_000)).toBe(300_000);
  });

  it("stop() 後不重連", () => {
    const { s } = make();
    FakeWS.instances[0].open();
    s.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(1);
  });
});

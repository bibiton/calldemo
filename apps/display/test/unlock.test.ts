import { describe, expect, it, vi } from "vitest";
import { AudioGate, detectMode } from "../src/audio/unlock";

function fakeCtx(state: "running" | "suspended" = "suspended") {
  const c = {
    state,
    resume: vi.fn(async () => {
      c.state = "running";
    }),
  };
  return c;
}

describe("模式判斷（ADR-027）", () => {
  it("UA 含 QueueDisplayApp/ 或有 QCSNative → app；否則 web", () => {
    expect(detectMode("Mozilla/5.0 QueueDisplayApp/1.0", {})).toBe("app");
    expect(detectMode("Mozilla/5.0", { QCSNative: {} })).toBe("app");
    expect(detectMode("Mozilla/5.0 Chrome/140", {})).toBe("web");
  });
});

describe("T16 未解鎖音訊提示", () => {
  it("AudioContext suspended → 顯示「請點一下畫面啟用聲音」；收到叫號時提示變紅", () => {
    const g = new AudioGate({ mode: "web", ctx: fakeCtx(), report: () => {} });
    g.check();
    expect(g.view).toEqual({ prompt: true, alert: false });
    g.onCallWhileBlocked();
    expect(g.view).toEqual({ prompt: true, alert: true });
  });
  it("running → 不顯示", () => {
    const g = new AudioGate({ mode: "web", ctx: fakeCtx("running"), report: () => {} });
    g.check();
    expect(g.view.prompt).toBe(false);
  });
});

describe("T16b 音訊被擋回報", () => {
  it("play() reject NotAllowedError → 送 blocked 一次（狀態不變不重送）；解鎖後送 ok", async () => {
    const report = vi.fn();
    const ctx = fakeCtx("running");
    const g = new AudioGate({ mode: "web", ctx, report });
    g.check();
    expect(report.mock.calls).toEqual([["ok"]]);
    const e = Object.assign(new Error("x"), { name: "NotAllowedError" });
    g.onPlayError(e);
    g.onPlayError(e);
    ctx.state = "suspended";
    g.check();
    expect(report.mock.calls).toEqual([["ok"], ["blocked"]]);
    expect(await g.handleUserEvent({ type: "pointerup" })).toBe(true);
    expect(report.mock.calls).toEqual([["ok"], ["blocked"], ["ok"]]);
    expect(g.view).toEqual({ prompt: false, alert: false });
  });
  it("其他錯誤（解碼失敗）不算被擋", () => {
    const report = vi.fn();
    const g = new AudioGate({ mode: "web", ctx: fakeCtx("running"), report });
    g.check();
    g.onPlayError(new Error("decode"));
    expect(report.mock.calls).toEqual([["ok"]]);
  });
});

describe("T16c app／web 模式", () => {
  it("app 模式音訊被擋：不顯示任何提示，但仍回報 blocked", () => {
    const report = vi.fn();
    const g = new AudioGate({ mode: "app", ctx: fakeCtx("suspended"), report });
    g.check();
    g.onCallWhileBlocked();
    expect(g.view).toEqual({ prompt: false, alert: false });
    expect(report).toHaveBeenCalledWith("blocked");
  });
  it("web 模式 keydown Enter 可解鎖；Esc 不解鎖", async () => {
    const ctx = fakeCtx("suspended");
    const g = new AudioGate({ mode: "web", ctx, report: () => {} });
    g.check();
    expect(await g.handleUserEvent({ type: "keydown", key: "Escape" })).toBe(false);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(g.view.prompt).toBe(true);
    expect(await g.handleUserEvent({ type: "keydown", key: "Enter" })).toBe(true);
    expect(g.view.prompt).toBe(false);
  });
});

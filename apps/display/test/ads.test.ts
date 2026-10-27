import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdController, PausableTimer } from "../src/ads/ad-controller";

class FakeVideo {
  paused = true;
  muted = false;
  currentTime = 0;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

describe("T15 叫號時廣告讓位", () => {
  it("播放中收到叫號 → muted＋pause；佇列清空後恢復，從原位置續播、音量狀態還原", async () => {
    const v = new FakeVideo();
    await v.play();
    v.currentTime = 12.5;
    const ctl = new AdController();
    ctl.attachVideo(v as unknown as HTMLVideoElement);
    ctl.pauseForCall();
    expect(v.muted).toBe(true);
    expect(v.pause).toHaveBeenCalledTimes(1);
    expect(v.paused).toBe(true);
    ctl.resumeAfterCall();
    expect(v.muted).toBe(false);
    expect(v.currentTime).toBe(12.5);
    expect(v.play).toHaveBeenCalledTimes(2);
  });

  it("原本就暫停的影片，叫號後不會被自動播放；原本靜音的維持靜音", async () => {
    const v = new FakeVideo();
    v.muted = true;
    const ctl = new AdController();
    ctl.attachVideo(v as unknown as HTMLVideoElement);
    ctl.pauseForCall();
    ctl.resumeAfterCall();
    expect(v.play).not.toHaveBeenCalled();
    expect(v.muted).toBe(true);
  });

  it("叫號期間換上的新影片也立即靜音暫停", async () => {
    const ctl = new AdController();
    ctl.pauseForCall();
    const v = new FakeVideo();
    ctl.attachVideo(v as unknown as HTMLVideoElement);
    expect(ctl.isHeld).toBe(true);
    expect(v.muted).toBe(true);
  });
});

describe("圖片輪播計時器同樣暫停", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("暫停期間不換張，恢復後只跑剩餘時間", () => {
    const fn = vi.fn();
    const t = new PausableTimer();
    t.start(10_000, fn);
    vi.advanceTimersByTime(4_000);
    t.pause();
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    t.resume();
    vi.advanceTimersByTime(5_999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("AdController 叫號時暫停圖片計時器", () => {
    const fn = vi.fn();
    const ctl = new AdController();
    ctl.timer.start(5_000, fn);
    ctl.pauseForCall();
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
    ctl.resumeAfterCall();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

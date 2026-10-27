/** 叫號時廣告讓位（ADR-017、T15）：影片靜音＋暫停，佇列清空後從原位置續播；圖片計時器同樣暫停。 */
export class PausableTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remaining = 0;
  private startedAt = 0;
  private cb: (() => void) | null = null;
  private paused = false;

  start(ms: number, cb: () => void): void {
    this.clear();
    this.cb = cb;
    this.remaining = ms;
    if (!this.paused) this.arm();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
      this.remaining -= Date.now() - this.startedAt;
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.cb) this.arm();
  }

  clear(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
    this.cb = null;
  }

  private arm(): void {
    this.startedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      const cb = this.cb;
      this.cb = null;
      cb?.();
    }, Math.max(0, this.remaining));
  }
}

export class AdController {
  readonly timer = new PausableTimer();
  private video: HTMLVideoElement | null = null;
  private held = false;
  private saved: { muted: boolean; wasPlaying: boolean } | null = null;

  get isHeld(): boolean {
    return this.held;
  }

  attachVideo(v: HTMLVideoElement | null): void {
    this.video = v;
    if (v && this.held) {
      this.saved = { muted: v.muted, wasPlaying: true };
      v.muted = true;
      v.pause();
    }
  }

  pauseForCall(): void {
    if (this.held) return;
    this.held = true;
    this.timer.pause();
    const v = this.video;
    if (v) {
      this.saved = { muted: v.muted, wasPlaying: !v.paused };
      v.muted = true;
      v.pause();
    }
  }

  resumeAfterCall(): void {
    if (!this.held) return;
    this.held = false;
    const v = this.video;
    if (v && this.saved) {
      v.muted = this.saved.muted;
      if (this.saved.wasPlaying) void v.play().catch(() => {});
    }
    this.saved = null;
    this.timer.resume();
  }
}

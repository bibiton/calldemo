/** 音訊解鎖與被擋回報（ADR-027）：app 模式完全不出現提示，web 模式支援遙控器／鍵盤／點擊。 */
export type DisplayMode = "app" | "web";
export type AudioStatus = "ok" | "blocked";

export function detectMode(ua: string, win: Record<string, unknown>): DisplayMode {
  return ua.includes("QueueDisplayApp/") || !!win.QCSNative ? "app" : "web";
}

interface CtxLike {
  state: string;
  resume(): Promise<void>;
}

export interface UserEventLike {
  type: string;
  key?: string;
}

/** HTML 標準：Esc 不屬於 activation-triggering input（keydown 其他鍵可）。 */
const NON_ACTIVATING_KEYS = new Set(["Escape", "Esc"]);

export class AudioGate {
  private status: AudioStatus | null = null;
  private alert = false;
  private listeners = new Set<() => void>();

  constructor(private o: { mode: DisplayMode; ctx: CtxLike; report: (s: AudioStatus) => void; onUnlocked?: () => void }) {}

  get view(): { prompt: boolean; alert: boolean } {
    const prompt = this.o.mode === "web" && this.status === "blocked";
    return { prompt, alert: prompt && this.alert };
  }

  get blocked(): boolean {
    return this.status === "blocked";
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  check(): void {
    this.set(this.o.ctx.state === "running" ? "ok" : "blocked");
  }

  onPlayError(e: unknown): void {
    if ((e as { name?: string })?.name === "NotAllowedError") this.set("blocked");
  }

  onCallWhileBlocked(): void {
    if (this.status !== "blocked") return;
    this.alert = true;
    this.emit();
  }

  /** 使用者操作（keydown／pointerup／mousedown／touchend）：嘗試 resume。回傳是否解鎖。 */
  async handleUserEvent(ev: UserEventLike): Promise<boolean> {
    if (ev.type === "keydown" && ev.key && NON_ACTIVATING_KEYS.has(ev.key)) return false;
    try {
      await this.o.ctx.resume();
    } catch {
      return false;
    }
    if (this.o.ctx.state !== "running") return false;
    const was = this.status;
    this.set("ok");
    if (was === "blocked") this.o.onUnlocked?.();
    return true;
  }

  private set(s: AudioStatus): void {
    if (this.status === s) return;
    this.status = s;
    if (s === "ok") this.alert = false;
    this.o.report(s);
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

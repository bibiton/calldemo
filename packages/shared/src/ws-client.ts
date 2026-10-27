/** 客戶端 WebSocket：文字心跳、退避重連、lastSeq 去重與跳號 resync（04 §2、§4）。 */
export const PING_EVERY_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;

export type SocketStatus = "connecting" | "open" | "closed" | "suspended";

export interface QcsSocketOptions {
  url: (lastSeq: number | null) => string;
  protocols: () => string[];
  onMessage: (msg: any) => void;
  onStatus?: (s: SocketStatus, closeCode?: number) => void;
  WebSocketImpl?: typeof WebSocket;
  gapCheck?: boolean;
  initialLastSeq?: number | null;
  onSeq?: (seq: number) => void;
  maxBackoffMs?: () => number;
  random?: () => number;
}

export function backoffDelay(attempt: number, random: () => number = Math.random, max = 30_000): number {
  const base = Math.min(max, 1000 * 2 ** attempt);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.min(max, Math.round(base * jitter));
}

export class QcsSocket {
  lastSeq: number | null;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: QcsSocketOptions) {
    this.lastSeq = o.initialLastSeq ?? null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(code = 1000): void {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(code);
    } catch {
      /* already closed */
    }
  }

  send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    return true;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }

  private connect(): void {
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    this.o.onStatus?.("connecting");
    const ws = new Impl(this.o.url(this.lastSeq), this.o.protocols());
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.o.onStatus?.("open");
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handle(String(e.data));
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (e.code === 4003) {
        this.o.onStatus?.("suspended", e.code);
        return;
      }
      this.o.onStatus?.("closed", e.code);
      if (!this.stopped) this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose 會接著觸發 */
    };
  }

  private ping(): void {
    if (!this.send("ping")) return;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      try {
        this.ws?.close(4000);
      } catch {
        /* ignore */
      }
    }, PONG_TIMEOUT_MS);
  }

  private handle(raw: string): void {
    if (raw === "pong") {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.t === "evt" && typeof msg.seq === "number") {
      if (msg.type === "snapshot" || msg.type === "hello") {
        this.setSeq(msg.type === "snapshot" ? msg.seq : this.lastSeq ?? null);
      } else {
        if (this.lastSeq !== null && msg.seq <= this.lastSeq) return;
        if (this.o.gapCheck !== false && this.lastSeq !== null && msg.seq > this.lastSeq + 1) {
          this.send({ t: "resync" });
        }
        this.setSeq(msg.seq);
      }
    }
    this.o.onMessage(msg);
  }

  private setSeq(seq: number | null): void {
    if (seq === null) return;
    this.lastSeq = seq;
    this.o.onSeq?.(seq);
  }

  private scheduleRetry(): void {
    const max = this.o.maxBackoffMs?.() ?? 30_000;
    const d = backoffDelay(this.attempt++, this.o.random, max);
    this.retryTimer = setTimeout(() => this.connect(), d);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }
}

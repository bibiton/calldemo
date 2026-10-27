/**
 * Web Audio 播放：decodeAudioData 預載＋start(t) 依 gapsMs 精準排程（不用 <audio> 串接）。
 * 任一片段缺檔／解碼失敗 → 整句改用 speechSynthesis（最後備援，ADR-003），並標記「語音素材不完整」。
 */
import type { Plan } from "./types";

const LRU_MAX = 200;

export class NotAllowedError extends Error {
  name = "NotAllowedError";
}

export interface PlayerLog {
  type: "start" | "end" | "fallback" | "blocked";
  number: string;
  kind: string;
  keys: string[];
  at: number;
}

export class WebAudioPlayer {
  readonly ctx: AudioContext;
  private gain: GainNode;
  private cache = new Map<string, Promise<AudioBuffer>>();
  incomplete = false;
  onIncomplete?: () => void;

  constructor(private log: (e: PlayerLog) => void = () => {}) {
    const Ctor: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctor();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  setVolume(v: number): void {
    this.gain.gain.value = v;
  }

  load(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url);
      this.cache.set(url, hit);
      return hit;
    }
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
        return r.arrayBuffer();
      })
      .then((b) => this.ctx.decodeAudioData(b));
    p.catch(() => this.cache.delete(url));
    this.cache.set(url, p);
    while (this.cache.size > LRU_MAX) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  preload(urls: string[]): void {
    for (const u of urls) void this.load(u).catch(() => {});
  }

  /** 播完才 resolve；音訊被擋時 reject NotAllowedError。 */
  async play(plan: Plan): Promise<void> {
    const meta = { number: plan.item.number, kind: plan.item.kind, keys: plan.segments.map((s) => s.key) };
    if (this.ctx.state !== "running") {
      this.log({ type: "blocked", ...meta, at: Date.now() });
      throw new NotAllowedError("AudioContext not running");
    }
    let buffers: AudioBuffer[] | null = null;
    if (!plan.speechOnly) {
      try {
        buffers = await Promise.all(plan.segments.map((s) => this.load(s.url)));
      } catch (e) {
        console.warn("[audio] segment missing, fallback to speechSynthesis", e);
      }
    }
    if (!buffers) {
      this.markIncomplete();
      this.log({ type: "fallback", ...meta, at: Date.now() });
      await speak(plan.text);
      return;
    }
    this.log({ type: "start", ...meta, at: Date.now() });
    let t = this.ctx.currentTime + 0.05;
    let last: AudioBufferSourceNode | null = null;
    plan.segments.forEach((s, i) => {
      t += s.gapBeforeMs / 1000;
      const src = this.ctx.createBufferSource();
      src.buffer = buffers![i];
      src.connect(this.gain);
      src.start(t);
      t += buffers![i].duration;
      last = src;
    });
    const total = (t - this.ctx.currentTime) * 1000;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      if (last) (last as AudioBufferSourceNode).onended = done;
      setTimeout(done, total + 500); // onended 未觸發（分頁背景節流）時的保底
    });
    this.log({ type: "end", ...meta, at: Date.now() });
  }

  private markIncomplete(): void {
    if (this.incomplete) return;
    this.incomplete = true;
    this.onIncomplete?.();
  }
}

function speak(text: string): Promise<void> {
  const synth = (window as any).speechSynthesis as SpeechSynthesis | undefined;
  if (!synth) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
    setTimeout(resolve, 15_000);
  });
}

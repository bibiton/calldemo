/**
 * 語音包漸進快取（07-notifications §7、ADR-026）：開機不等全部下載完；背景依序抓檔讓 Service Worker 存進 Cache Storage，
 * 之後斷網也能唸。同時最多 4 個請求，叫號播放時暫停（不搶頻寬）。
 * 1. 叮咚、句型片段、「來賓」與已啟用主題包的前綴　2. 各字首 1～200 號　3. 其餘號碼（201～999）
 */
import { formatNumber } from "@qcs/shared";
import { numberFiles } from "@qcs/shared/voice/plan";
import type { Manifest } from "@qcs/shared/voice/types";
import type { VoiceSettings } from "@qcs/shared/voice/settings";

export const WARM_CONCURRENCY = 4;

export function warmUrls(m: Manifest, s: VoiceSettings, services: { prefix: string }[], base = "/audio/"): string[] {
  const out: string[] = [];
  const add = (f: string) => out.push(base + f);
  for (const f of m.files) if (f.category === "chime" || f.category === "phrase" || f.key === "prefix.std") add(f.file);
  if (s.mode === "fun") {
    const packs = s.enabledPacks.length ? new Set(s.enabledPacks) : null;
    for (const f of m.files) {
      if (f.category !== "prefix" || f.key === "prefix.std" || f.manualOnly) continue;
      if (packs ? packs.has(f.pack ?? "") : f.defaultEnabled) add(f.file);
    }
  }
  for (const f of m.files) if (f.category === "counter") add(f.file);
  const [lo, hi] = m.rules.number.combined.range;
  for (const [from, to] of [[lo, Math.min(200, hi)], [201, hi]] as const) {
    for (let n = from; n <= to; n++) for (const sv of services) for (const f of numberFiles(m, formatNumber(sv.prefix, n))) add(f);
  }
  return [...new Set(out)];
}

/** 背景下載佇列：限制並行數、可暫停／恢復、同一網址只抓一次。 */
export class AudioWarmer {
  private queue: string[] = [];
  private seen = new Set<string>();
  private active = 0;
  private paused = false;

  constructor(private fetchOne: (url: string) => Promise<void>, private limit = WARM_CONCURRENCY) {}

  enqueue(urls: string[]): void {
    for (const u of urls) {
      if (this.seen.has(u)) continue;
      this.seen.add(u);
      this.queue.push(u);
    }
    this.pump();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  get pending(): number {
    return this.queue.length + this.active;
  }

  private pump(): void {
    while (!this.paused && this.active < this.limit && this.queue.length) {
      const u = this.queue.shift()!;
      this.active++;
      void this.fetchOne(u)
        .catch(() => this.seen.delete(u)) // 失敗的下次再試
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

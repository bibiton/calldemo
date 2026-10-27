import type { CallItem } from "./types";

/** 叫號播放佇列：序列、不重疊；同一號碼尚在排隊時合併（ADR-017）。 */
export class CallQueue {
  private pending: CallItem[] = [];
  private running = false;
  private waiters: (() => void)[] = [];

  constructor(private o: { play: (item: CallItem) => Promise<void>; onBusyChange?: (busy: boolean) => void }) {}

  enqueue(item: CallItem): void {
    const i = this.pending.findIndex((p) => p.ticketId === item.ticketId);
    if (i >= 0) this.pending[i] = item;
    else this.pending.push(item);
    void this.run();
  }

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  idle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.o.onBusyChange?.(true);
    while (this.pending.length) {
      const item = this.pending.shift()!;
      try {
        await this.o.play(item);
      } catch (e) {
        console.warn("[call-queue] play failed", item.number, e);
      }
    }
    this.running = false;
    this.o.onBusyChange?.(false);
    for (const w of this.waiters.splice(0)) w();
  }
}

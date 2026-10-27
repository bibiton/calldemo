import { describe, expect, it, vi } from "vitest";
import { CallQueue } from "../src/audio/call-queue";
import { toAnnouncement } from "../src/announce";

function fakePlayer(ms = 50) {
  const log: { key: string; start: number; end: number }[] = [];
  let active = 0;
  let maxActive = 0;
  return {
    log,
    get maxActive() {
      return maxActive;
    },
    async play(item: { ticketId: string }) {
      active++;
      maxActive = Math.max(maxActive, active);
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      active--;
      log.push({ key: item.ticketId, start, end: Date.now() });
    },
  };
}

const ann = (id: string, kind: "call" | "recall" = "call") => ({ ticketId: id, number: id, counterNo: 1, kind });

describe("T14 叫號播放佇列", () => {
  it("連續 3 筆依序播放、不重疊；佇列忙碌狀態開始／結束各通知一次", async () => {
    const player = fakePlayer();
    const busy = vi.fn();
    const q = new CallQueue({ play: (a) => player.play(a), onBusyChange: busy });
    q.enqueue(ann("A001"));
    q.enqueue(ann("A002"));
    q.enqueue(ann("A003"));
    await q.idle();
    expect(player.log.map((x) => x.key)).toEqual(["A001", "A002", "A003"]);
    expect(player.maxActive).toBe(1);
    for (let i = 1; i < 3; i++) expect(player.log[i].start).toBeGreaterThanOrEqual(player.log[i - 1].end);
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it("同一號碼在佇列中重複出現時合併為一次（正在播的不算）", async () => {
    const player = fakePlayer();
    const q = new CallQueue({ play: (a) => player.play(a) });
    q.enqueue(ann("A001"));
    q.enqueue(ann("A002"));
    q.enqueue(ann("A002", "recall"));
    q.enqueue(ann("A001"));
    await q.idle();
    expect(player.log.map((x) => x.key)).toEqual(["A001", "A002", "A001"]);
  });

  it("單筆播放失敗不影響下一筆", async () => {
    const played: string[] = [];
    const q = new CallQueue({
      play: async (a) => {
        if (a.ticketId === "bad") throw new Error("decode");
        played.push(a.ticketId);
      },
    });
    q.enqueue(ann("bad"));
    q.enqueue(ann("A002"));
    await q.idle();
    expect(played).toEqual(["A002"]);
  });
});

describe("T14 補推的舊叫號不播放", () => {
  const now = 1_800_000_000_000;
  const evt = (type: string, at: number, data: Record<string, unknown> = {}) => ({
    t: "evt",
    seq: 1,
    at,
    type,
    data: { id: "t1", number: "A023", counterNo: 2, recallCount: 0, ...data },
  });
  it("即時 ticket.called → 播放；recallCount>0 → recall", () => {
    expect(toAnnouncement(evt("ticket.called", now - 500), now)).toMatchObject({ kind: "call", number: "A023", counterNo: 2 });
    expect(toAnnouncement(evt("ticket.called", now, { recallCount: 1 }), now)).toMatchObject({ kind: "recall" });
  });
  it("at 早於現在 30 秒以上 → 不播放", () => {
    expect(toAnnouncement(evt("ticket.called", now - 30_001), now)).toBeNull();
  });
  it("即時 ticket.skipped → 過號提醒；其他事件不播", () => {
    expect(toAnnouncement(evt("ticket.skipped", now), now)).toMatchObject({ kind: "skipped" });
    expect(toAnnouncement(evt("ticket.created", now), now)).toBeNull();
    expect(toAnnouncement(evt("ticket.done", now), now)).toBeNull();
  });
});

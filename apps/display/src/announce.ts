import { REPLAY_STALE_MS } from "@qcs/shared";
import type { CallItem } from "./audio/types";

/** 事件 → 播報項目。只有「即時」的 ticket.called／ticket.skipped 會播；補推的舊事件只更新畫面（04 §3）。 */
export function toAnnouncement(evt: { type: string; at: number; data: any }, serverNow: number): CallItem | null {
  if (serverNow - evt.at > REPLAY_STALE_MS) return null;
  const d = evt.data ?? {};
  if (evt.type === "ticket.called") {
    return { ticketId: d.id, number: d.number, counterNo: d.counterNo ?? null, kind: d.recallCount > 0 ? "recall" : "call" };
  }
  if (evt.type === "ticket.skipped") return { ticketId: d.id, number: d.number, counterNo: d.counterNo ?? null, kind: "skipped" };
  return null;
}

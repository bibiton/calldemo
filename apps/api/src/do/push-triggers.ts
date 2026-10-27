/** 推播觸發規則（07-notifications §1），純函式，DO 只負責查資料與送 Queue。 */
import type { StoreInfo } from "@qcs/shared";
import type { PushMessage } from "../env";

export const NOTIFY_AHEAD_DEFAULT = 3;

/** 門店設定的「前面剩幾位提醒」，夾在 1～5。 */
export function notifyAheadOf(cfg: StoreInfo | null): number {
  const n = Number(cfg?.notifyAhead ?? NOTIFY_AHEAD_DEFAULT);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : NOTIFY_AHEAD_DEFAULT;
}

/** 哪些事件要通知當事人：叫號（含重叫）、過號。 */
export function pushKindFor(type: string): PushMessage["t"] | null {
  if (type === "ticket.called") return "called";
  if (type === "ticket.skipped") return "skipped";
  return null;
}

/**
 * 非營業時間判斷（夜間 DO 未休眠警示，12 §6）。DO 與彙總共用；純函式，不碰儲存。
 */
import { businessDate, dayOfWeek, localMinutes, type BusinessHour } from "@qcs/shared";

/** 沒設定營業時間的門店：當地 02:00～06:00 視為深夜（ADR-044），避免「全天營業」讓夜間警示永遠不觸發。 */
export const DEFAULT_NIGHT = { from: 2 * 60, to: 6 * 60 };

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** ms 這個時刻在門店當地是否為非營業時間（小時桶以整點開始時刻判斷）。 */
export function isOffHours(ms: number, tz: string, hours: BusinessHour[]): boolean {
  const min = localMinutes(ms, tz);
  if (!hours.length) return min >= DEFAULT_NIGHT.from && min < DEFAULT_NIGHT.to;
  const dow = dayOfWeek(businessDate(ms, tz));
  const prev = (dow + 6) % 7;
  for (const h of hours) {
    const o = toMin(h.open);
    const c = toMin(h.close);
    if (h.dow === dow && (c > o ? min >= o && min < c : min >= o)) return false;
    if (h.dow === prev && c <= o && min < c) return false; // 前一天跨午夜的營業時段
  }
  return true;
}

export interface BusinessHour {
  dow: number; // 0=週日
  open: string; // HH:MM
  close: string; // HH:MM；小於 open 代表跨午夜
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** 門店時區的日期 YYYY-MM-DD。 */
export function businessDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 門店時區的分鐘數（0～1439）。 */
export function localMinutes(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return p.hour * 60 + p.minute;
}

function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 門店時區的「日期＋時刻」轉 UTC epoch ms（兩次修正處理夏令時間）。 */
export function zonedTimeToUtc(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return t;
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const CLOSE_ALARM_DELAY_MS = 30 * 60_000;

/** 關店 alarm 時間：該營業日關店時刻 + 30 分（ADR-015）。無設定時以 23:59 計。 */
export function closeAlarmAt(date: string, hours: BusinessHour[], tz: string): number {
  const dow = dayOfWeek(date);
  const today = hours.filter((h) => h.dow === dow);
  if (today.length === 0) return zonedTimeToUtc(date, "23:59", tz) + CLOSE_ALARM_DELAY_MS;
  let latest = 0;
  for (const h of today) {
    let t = zonedTimeToUtc(date, h.close, tz);
    if (h.close <= h.open) t += 24 * 3600_000;
    latest = Math.max(latest, t);
  }
  return latest + CLOSE_ALARM_DELAY_MS;
}

/** 目前是否在營業時間內（面板據此切「休息中」）。空設定＝全天營業。 */
export function isOpenAt(ms: number, hours: BusinessHour[], tz: string): boolean {
  if (!hours.length) return true;
  const date = businessDate(ms, tz);
  const dow = dayOfWeek(date);
  const mins = localMinutes(ms, tz);
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const prevDow = (dow + 6) % 7;
  return hours.some((h) => {
    const o = toMin(h.open);
    const c = toMin(h.close);
    if (c > o) return h.dow === dow && mins >= o && mins < c;
    return (h.dow === dow && mins >= o) || (h.dow === prevDow && mins < c);
  });
}

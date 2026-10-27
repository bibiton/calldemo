/**
 * 報表（05-apps §4、03 daily_stats）：每日彙總由 tickets_history 計算，結果永久保存（無個資）。
 * 每小時 Cron 在門店當地 03 點結算「昨天」（關店 alarm＋q-history 都已完成）；查詢時缺的日子也會即時補算。
 */
import { businessDate } from "@qcs/shared";
import type { Env } from "./env";

export interface HistLite {
  service_id: string;
  final_status: string;
  created_at: number;
  called_at: number | null;
  serving_at: number | null;
  ended_at: number;
}

export interface DayStat {
  service_id: string;
  issued: number;
  done: number;
  skipped: number;
  no_show: number;
  cancelled: number;
  avg_wait_ms: number | null;
  p90_wait_ms: number | null;
  avg_service_ms: number | null;
  peak_hour: number | null;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** nearest-rank 百分位 */
function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}

export function aggregateDay(rows: HistLite[], tz: string): DayStat[] {
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" });
  const by = new Map<string, HistLite[]>();
  for (const r of rows) by.set(r.service_id, [...(by.get(r.service_id) ?? []), r]);
  return [...by.keys()].sort().map((svc) => {
    const rs = by.get(svc)!;
    const waits = rs.filter((r) => r.called_at != null).map((r) => r.called_at! - r.created_at);
    const service = rs.filter((r) => r.final_status === "done" && r.serving_at != null).map((r) => r.ended_at - r.serving_at!);
    const hours = new Map<number, number>();
    for (const r of rs) {
      const h = Number(hourFmt.format(r.created_at));
      hours.set(h, (hours.get(h) ?? 0) + 1);
    }
    let peak: number | null = null;
    for (const [h, n] of [...hours.entries()].sort((a, b) => a[0] - b[0])) if (peak === null || n > hours.get(peak)!) peak = h;
    const count = (st: string) => rs.filter((r) => r.final_status === st).length;
    return {
      service_id: svc,
      issued: rs.length,
      done: count("done"),
      skipped: count("skipped"),
      no_show: count("no_show"),
      cancelled: count("cancelled"),
      avg_wait_ms: avg(waits),
      p90_wait_ms: pct(waits, 0.9),
      avg_service_ms: avg(service),
      peak_hour: peak,
    };
  });
}

/** 重算一天（先刪後寫，同一 batch，冪等）。 */
export async function computeDailyStats(env: Env, storeId: string, bd: string, tz: string): Promise<DayStat[]> {
  const rows = await env.DB.prepare(
    "SELECT service_id, final_status, created_at, called_at, serving_at, ended_at FROM tickets_history WHERE store_id=? AND business_date=?",
  ).bind(storeId, bd).all<HistLite>();
  const stats = aggregateDay(rows.results, tz);
  const ins = env.DB.prepare(
    `INSERT INTO daily_stats(store_id,business_date,service_id,issued,done,skipped,no_show,cancelled,avg_wait_ms,p90_wait_ms,avg_service_ms,peak_hour)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM daily_stats WHERE store_id=? AND business_date=?").bind(storeId, bd),
    ...stats.map((x) => ins.bind(storeId, bd, x.service_id, x.issued, x.done, x.skipped, x.no_show, x.cancelled, x.avg_wait_ms, x.p90_wait_ms, x.avg_service_ms, x.peak_hour)),
  ]);
  return stats;
}

const DAY = 24 * 3600_000;

/** 每小時 Cron：當地時間 03 點的門店結算昨天。 */
export async function runDailyStats(env: Env, now: number): Promise<number> {
  const stores = await env.DB.prepare("SELECT id, timezone FROM stores").all<{ id: string; timezone: string }>();
  let n = 0;
  for (const s of stores.results) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (hour !== 3) continue;
    await computeDailyStats(env, s.id, businessDate(now - DAY, s.timezone), s.timezone);
    n++;
  }
  return n;
}

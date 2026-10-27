/**
 * 總後台異常警示（12-usage-metering §6）。一次查多家店（批次 SQL），不喚醒任何 DO。
 * 依據：usage_daily 最近一個完整 UTC 日、devices.audio_status、ad_assets 容量。
 */
import type { Env } from "../env";

export type AlertKind = "night_wake" | "request_spike" | "per_ticket" | "ad_quota" | "panel_muted" | "push_fail";
export interface Alert {
  kind: AlertKind;
  level: "amber" | "red";
  text: string;
  value?: number;
}

export const ALERT_RULES = {
  nightWakesPerHour: 10,
  spikeFactor: 3,
  spikeMin: 5000,
  perTicketMax: 20,
  adAmber: 0.9,
  adRed: 1,
  mutedMs: 5 * 60_000,
  pushFailRate: 0.2,
  /** 推播樣本太少時不判斷（避免 1 則失敗就 100% 誤報，ADR-044） */
  pushMinSample: 10,
} as const;

const DAY = 86400_000;
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const inQ = (n: number) => Array.from({ length: n }, () => "?").join(",");

export async function storeAlerts(env: Env, storeIds: string[], now: number): Promise<Map<string, Alert[]>> {
  const out = new Map<string, Alert[]>(storeIds.map((id) => [id, []]));
  if (!storeIds.length) return out;
  const add = (id: string, a: Alert) => out.get(id)?.push(a);
  const y = utcDate(now - DAY);
  const w0 = utcDate(now - 8 * DAY);
  // D1 一次查詢最多 100 個綁定參數 → 分段
  for (let i = 0; i < storeIds.length; i += 90) {
    const ids = storeIds.slice(i, i + 90);
    const [daily, muted, ads] = await env.DB.batch([
      env.DB.prepare(`SELECT * FROM usage_daily WHERE store_id IN (${inQ(ids.length)}) AND date BETWEEN ? AND ? ORDER BY date`).bind(...ids, w0, y),
      env.DB.prepare(
        `SELECT store_id, name, audio_status_at FROM devices WHERE store_id IN (${inQ(ids.length)}) AND kind='display' AND status='active' AND audio_status='blocked' AND audio_status_at <= ?`,
      ).bind(...ids, now - ALERT_RULES.mutedMs),
      env.DB.prepare(
        `SELECT s.id AS store_id, s.ad_quota_bytes AS quota, COALESCE((SELECT SUM(bytes) FROM ad_assets a WHERE a.owner_type='store' AND a.owner_id=s.id AND a.status='ready'),0) AS used
         FROM stores s WHERE s.id IN (${inQ(ids.length)})`,
      ).bind(...ids),
    ]);
    const byStore = new Map<string, any[]>();
    for (const r of daily.results as any[]) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r]);
    for (const [id, rows] of byStore) {
      const last = rows.find((r) => r.date === y);
      if (!last) continue;
      if (last.do_wakes_offhours_max > ALERT_RULES.nightWakesPerHour)
        add(id, { kind: "night_wake", level: "red", text: `夜間 DO 未休眠（每小時最多喚醒 ${last.do_wakes_offhours_max} 次）`, value: last.do_wakes_offhours });
      const prev = rows.filter((r) => r.date < y);
      const avg = prev.length ? prev.reduce((a, r) => a + r.api_requests, 0) / prev.length : 0;
      if (prev.length && last.api_requests > ALERT_RULES.spikeMin && last.api_requests > avg * ALERT_RULES.spikeFactor)
        add(id, { kind: "request_spike", level: "amber", text: `請求量暴增：${last.api_requests.toLocaleString("en-US")}（近 7 日平均 ${Math.round(avg).toLocaleString("en-US")}）`, value: last.api_requests });
      if (last.tickets > 0 && last.do_requests_est / last.tickets > ALERT_RULES.perTicketMax)
        add(id, { kind: "per_ticket", level: "amber", text: `每號 DO 請求過高：${(last.do_requests_est / last.tickets).toFixed(1)}`, value: last.do_requests_est / last.tickets });
      if (last.push_sent >= ALERT_RULES.pushMinSample && last.push_failed / last.push_sent > ALERT_RULES.pushFailRate)
        add(id, { kind: "push_fail", level: "amber", text: `推播失敗率 ${Math.round((last.push_failed / last.push_sent) * 100)}%`, value: last.push_failed / last.push_sent });
    }
    for (const r of muted.results as any[]) add(r.store_id, { kind: "panel_muted", level: "red", text: `叫號機「${r.name}」無法出聲` });
    for (const r of ads.results as any[]) {
      if (!r.quota) continue;
      const ratio = r.used / r.quota;
      if (ratio >= ALERT_RULES.adAmber)
        add(r.store_id, { kind: "ad_quota", level: ratio >= ALERT_RULES.adRed ? "red" : "amber", text: `廣告容量 ${Math.round(ratio * 100)}%`, value: ratio });
    }
  }
  return out;
}

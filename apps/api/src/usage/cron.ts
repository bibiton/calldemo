/**
 * 計量 Cron（12 §4）。沿用既有的每小時 Cron `5 * * * *`，依 UTC 時刻分派，不新增 Cron trigger：
 * - 每日 UTC 01:05：前一 UTC 日 AE 匯入 → 全店日彙總（留 1 小時給 AE 寫入延遲與晚到的 DO 桶）
 * - 每月 1 日 UTC 02:05：上月月結（usage_monthly；有帳單時含分攤）
 */
import type { Env } from "../env";
import { importAeDay, type AeFetch } from "./ae";
import { buildMonth, persistMonth, prevMonth, rollupDay, utcDate } from "./rollup";

export async function runUsageCron(env: Env, now: number, fetchFn: AeFetch = (r) => fetch(r)): Promise<Record<string, unknown>> {
  const d = new Date(now);
  const out: Record<string, unknown> = {};
  if (d.getUTCHours() === 1) {
    const date = utcDate(now - 86400_000);
    try {
      out.ae = await importAeDay(env, date, fetchFn);
    } catch (e) {
      // AE 失敗仍彙總 DO／推播欄位；下次重跑（或總後台查詢補算）時覆寫
      console.error("AE import failed", date, String(e));
      out.ae = { error: String(e) };
    }
    out.daily = { date, rows: await rollupDay(env, date) };
  }
  if (d.getUTCDate() === 1 && d.getUTCHours() === 2) {
    const month = prevMonth(now);
    out.monthly = { month, rows: await persistMonth(env, await buildMonth(env, month, now)) };
  }
  return out;
}

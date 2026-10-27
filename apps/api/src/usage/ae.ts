/**
 * Workers Analytics Engine（12 §2）：每個 API 請求結束時寫 1 個 data point（非同步、不影響回應）；
 * 每日 Cron 以 AE SQL API 查前一 UTC 日、依店依小時彙總，覆寫 usage_hourly 的 API 欄位。
 *
 * data point：indexes=[storeId 或 _platform]，blobs=[route, method, statusClass, role]，doubles=[1, wallMs]。
 * AE 會取樣：查詢一律乘 `_sample_interval`。
 */
import type { Env } from "../env";
import { PLATFORM, dayStart, utcDate } from "./rollup";

/** DO 寫的 AE 點（夜間喚醒）以 blob4='do' 區分，不算進 API 請求數 */
export const DO_ROLE = "do";

export interface ApiPoint {
  storeId: string | null;
  route: string;
  method: string;
  status: number;
  role: string;
  wallMs: number;
}

/** 依路徑判斷呼叫者角色（計量用，低基數）。 */
export function roleOf(path: string, query: URLSearchParams): string {
  if (path.startsWith("/api/admin")) return "platform";
  if (path.startsWith("/api/store")) return "store_admin";
  if (path.startsWith("/api/staff")) return "staff";
  if (path.startsWith("/api/display")) return "display";
  if (path.startsWith("/ws/")) return query.get("role") ?? "ws";
  if (path.startsWith("/api/s/") || path.startsWith("/api/tickets") || path.startsWith("/api/transfer")) return "customer";
  return "other";
}

export function writeApiPoint(env: Env, p: ApiPoint): void {
  if (!env.USAGE) return;
  try {
    env.USAGE.writeDataPoint({
      indexes: [(p.storeId || PLATFORM).slice(0, 96)],
      blobs: [p.route.slice(0, 120), p.method, `${Math.floor(p.status / 100)}xx`, p.role],
      doubles: [1, Math.max(0, Math.round(p.wallMs))],
    });
  } catch (e) {
    console.error("AE writeDataPoint failed", String(e)); // 計量失敗不影響回應
  }
}

export type AeFetch = (req: Request) => Promise<Response>;

export function aeConfigured(env: Env): boolean {
  return !!(env.CF_ACCOUNT_ID && env.AE_API_TOKEN && env.AE_DATASET);
}

const DATASET = /^[A-Za-z0-9_]{1,64}$/;

export async function aeSql(env: Env, sql: string, fetchFn: AeFetch): Promise<any[]> {
  const res = await fetchFn(
    new Request(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.AE_API_TOKEN}` },
      body: sql,
    }),
  );
  if (!res.ok) throw new Error(`AE SQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: any[] };
  return body.data ?? [];
}

const dt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** AE 回傳 "2026-10-27 05:00:00"（UTC）。 */
export const aeTime = (s: string) => Date.parse(`${String(s).replace(" ", "T")}Z`);

/** 匯入一個 UTC 日的 API 用量到 usage_hourly（覆寫 API 欄位，可重跑）。未設定 AE 時略過。 */
export async function importAeDay(env: Env, date: string, fetchFn: AeFetch): Promise<{ rows: number } | { skipped: string }> {
  if (!aeConfigured(env)) return { skipped: "AE_NOT_CONFIGURED" };
  if (!DATASET.test(env.AE_DATASET!)) return { skipped: "AE_DATASET_INVALID" };
  const from = dt(dayStart(date));
  const to = dt(dayStart(date) + 86400_000);
  const where = `timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}')`;
  const bucket = "toStartOfInterval(timestamp, INTERVAL '1' HOUR)";
  const api = `blob4 != '${DO_ROLE}'`;
  const [all, errs, wakes] = await Promise.all([
    aeSql(env, `SELECT index1 AS store, ${bucket} AS hour, SUM(_sample_interval) AS req, SUM(_sample_interval * double2) AS wall FROM ${env.AE_DATASET} WHERE ${where} AND ${api} GROUP BY store, hour FORMAT JSON`, fetchFn),
    aeSql(env, `SELECT index1 AS store, ${bucket} AS hour, SUM(_sample_interval) AS req FROM ${env.AE_DATASET} WHERE ${where} AND ${api} AND blob3 = '5xx' GROUP BY store, hour FORMAT JSON`, fetchFn),
    aeSql(env, `SELECT index1 AS store, ${bucket} AS hour, SUM(_sample_interval) AS req FROM ${env.AE_DATASET} WHERE ${where} AND blob4 = '${DO_ROLE}' AND blob1 = 'wake' GROUP BY store, hour FORMAT JSON`, fetchFn),
  ]);
  const key = (r: any) => `${r.store}|${aeTime(r.hour)}`;
  const errMap = new Map(errs.map((r) => [key(r), Number(r.req) || 0]));
  const wakeMap = new Map(wakes.map((r) => [key(r), Number(r.req) || 0]));
  const keys = new Map<string, { s: string; h: number }>();
  for (const r of [...all, ...wakes]) if (r.store && Number.isFinite(aeTime(r.hour))) keys.set(key(r), { s: String(r.store).slice(0, 96), h: aeTime(r.hour) });
  const allMap = new Map(all.map((r) => [key(r), r]));
  const rows = [...keys].map(([k, { s, h }]) => {
    const a = allMap.get(k);
    return { s, h, req: Math.round(Number(a?.req) || 0), err: Math.round(errMap.get(k) ?? 0), wall: Math.round(Number(a?.wall) || 0), nw: Math.round(wakeMap.get(k) ?? 0) };
  });
  // 先把該日 AE 來源欄位歸零（重跑時 AE 少掉的列不會殘留舊值），再覆寫
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE usage_hourly SET api_requests=0, api_errors=0, api_wall_ms=0, do_night_wakes=0 WHERE hour_start >= ? AND hour_start < ?").bind(dayStart(date), dayStart(date) + 86400_000),
  ];
  for (let i = 0; i < rows.length; i += 500) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO usage_hourly(store_id,hour_start,api_requests,api_errors,api_wall_ms,do_night_wakes)
         SELECT json_extract(value,'$.s'), json_extract(value,'$.h'), json_extract(value,'$.req'), json_extract(value,'$.err'), json_extract(value,'$.wall'), json_extract(value,'$.nw') FROM json_each(?) WHERE true
         ON CONFLICT(store_id,hour_start) DO UPDATE SET api_requests=excluded.api_requests, api_errors=excluded.api_errors, api_wall_ms=excluded.api_wall_ms, do_night_wakes=excluded.do_night_wakes`,
      ).bind(JSON.stringify(rows.slice(i, i + 500))),
    );
  }
  await env.DB.batch(stmts);
  return { rows: rows.length };
}

/** 總後台「今日」：即時查 AE（今天 UTC 0 點至今），依店加總。未設定時回 null。 */
export async function aeToday(env: Env, now: number, fetchFn: AeFetch): Promise<Map<string, number> | null> {
  if (!aeConfigured(env) || !DATASET.test(env.AE_DATASET!)) return null;
  const from = dt(dayStart(utcDate(now)));
  const rows = await aeSql(env, `SELECT index1 AS store, SUM(_sample_interval) AS req FROM ${env.AE_DATASET} WHERE timestamp >= toDateTime('${from}') AND blob4 != '${DO_ROLE}' GROUP BY store FORMAT JSON`, fetchFn);
  return new Map(rows.map((r) => [String(r.store), Math.round(Number(r.req) || 0)]));
}

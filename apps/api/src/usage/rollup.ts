/**
 * 用量彙總（12-usage-metering §3～§5）：usage_hourly → usage_daily → usage_monthly ＋ 帳單分攤。
 *
 * - DO 小時桶由 q-history consumer 累加進 usage_hourly（usageStatements）；遲到的桶會重算該日（recomputeLateDays）。
 * - API 請求數由 Analytics Engine 每日匯入（ae.ts，覆寫）；推播數由 q-push consumer 每批累加。
 * - 每日／每月由 Cron 計算；查詢時缺的過去日子也會補算（與報表 ADR-039 同一做法）。
 * - 大量寫入一律用 json_each 單一參數多列（D1 每查詢 100 個綁定參數、每次呼叫 1,000 查詢的限制）。
 */
import type { BusinessHour } from "@qcs/shared";
import { isOffHours } from "./hours";
import type { Env, UsageBucket } from "../env";
import { ASSUME, estDayCost } from "./prices";

const DAY = 86400_000;
const HOUR = 3600_000;
export const PLATFORM = "_platform";

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayStart(s));
export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayStart(from); t <= dayStart(to); t += DAY) out.push(utcDate(t));
  return out;
}
export const monthDates = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
};

// ---------- DO 小時桶（consumer）----------

const DO_COLS = [
  ["ws_connects", "wsConn"],
  ["ws_messages", "wsIn"],
  ["do_rpc", "rpc"],
  ["do_alarms", "alarms"],
  ["do_wakes", "wakes"],
  ["do_events", "events"],
  ["do_rows_written", "rowsW"],
  ["tickets", "tickets"],
  ["calls", "calls"],
] as const;

export const bucketHour = (h: string) => Date.parse(`${h}:00:00Z`);

/** DO 小時桶 → usage_hourly（同店同小時累加：同一小時可能分成多個桶送來）。 */
export function usageStatements(env: Env, storeId: string, buckets: UsageBucket[]): D1PreparedStatement[] {
  const rows = buckets
    .filter((b) => b && typeof b.h === "string" && Number.isFinite(bucketHour(b.h)))
    .map((b) => ({ s: storeId, h: bucketHour(b.h), ...Object.fromEntries(DO_COLS.map(([col, k]) => [col, Math.max(0, Math.round(Number((b as any)[k]) || 0))])) }));
  if (!storeId || !rows.length) return [];
  const cols = DO_COLS.map(([c]) => c);
  return [
    env.DB.prepare(
      `INSERT INTO usage_hourly(store_id,hour_start,${cols.join(",")})
       SELECT json_extract(value,'$.s'), json_extract(value,'$.h'), ${cols.map((c) => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?) WHERE true
       ON CONFLICT(store_id,hour_start) DO UPDATE SET ${cols.map((c) => `${c}=${c}+excluded.${c}`).join(", ")}`,
    ).bind(JSON.stringify(rows)),
  ];
}

/** 已彙總過的日子又收到 DO 桶（例如晚關店）→ 重算該店該日（冪等）。 */
export async function recomputeLateDays(env: Env, storeId: string, buckets: UsageBucket[], now: number): Promise<void> {
  const today = utcDate(now);
  const dates = [...new Set(buckets.map((b) => (typeof b?.h === "string" ? b.h.slice(0, 10) : "")).filter((d) => isDate(d) && d < today))];
  for (const d of dates) {
    const has = await env.DB.prepare("SELECT 1 FROM usage_daily WHERE store_id=? AND date=?").bind(storeId, d).first();
    if (has) await rollupDay(env, d, { storeIds: [storeId] });
  }
}

/** 推播計數（q-push consumer 每批結束，ADR-044）。 */
export function pushStatements(env: Env, counts: Map<string, { sent: number; failed: number }>, now: number): D1PreparedStatement[] {
  const h = Math.floor(now / HOUR) * HOUR;
  const rows = [...counts].filter(([s, c]) => s && (c.sent || c.failed)).map(([s, c]) => ({ s, h, sent: c.sent, failed: c.failed }));
  if (!rows.length) return [];
  return [
    env.DB.prepare(
      `INSERT INTO usage_hourly(store_id,hour_start,push_sent,push_failed)
       SELECT json_extract(value,'$.s'), json_extract(value,'$.h'), json_extract(value,'$.sent'), json_extract(value,'$.failed') FROM json_each(?) WHERE true
       ON CONFLICT(store_id,hour_start) DO UPDATE SET push_sent=push_sent+excluded.push_sent, push_failed=push_failed+excluded.push_failed`,
    ).bind(JSON.stringify(rows)),
  ];
}

// ---------- 每日 ----------

export interface DailyRow {
  store_id: string;
  date: string;
  api_requests: number;
  api_errors: number;
  ws_connects: number;
  ws_messages: number;
  do_rpc: number;
  do_wakes: number;
  do_requests_est: number;
  do_active_seconds_est: number;
  do_rows_written_est: number;
  do_wakes_offhours: number;
  do_wakes_offhours_max: number;
  tickets: number;
  calls: number;
  push_sent: number;
  push_failed: number;
  r2_bytes: number;
  d1_history_rows: number;
  est_cost_usd: number;
}

const DAILY_COLS: (keyof DailyRow)[] = [
  "store_id", "date", "api_requests", "api_errors", "ws_connects", "ws_messages", "do_rpc", "do_wakes", "do_requests_est", "do_active_seconds_est",
  "do_rows_written_est", "do_wakes_offhours", "do_wakes_offhours_max", "tickets", "calls", "push_sent", "push_failed", "r2_bytes", "d1_history_rows", "est_cost_usd",
];

export function dailyFromHourly(storeId: string, date: string, hourly: any[], tz: string | null, hours: BusinessHour[], r2: number, hist: number, daysInMonth: number): DailyRow {
  const sum = (k: string) => hourly.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  // 非營業時間喚醒：DO 自計（只有之後有寫入才會落地）與 DO 直接寫 AE 的夜間喚醒點（ADR-044）取較大者
  let off = 0;
  let offMax = 0;
  for (const r of hourly) {
    const w = Math.max(tz && r.do_wakes && isOffHours(r.hour_start, tz, hours) ? r.do_wakes : 0, Number(r.do_night_wakes) || 0);
    off += w;
    offMax = Math.max(offMax, w);
  }
  const d: DailyRow = {
    store_id: storeId,
    date,
    api_requests: sum("api_requests"),
    api_errors: sum("api_errors"),
    ws_connects: sum("ws_connects"),
    ws_messages: sum("ws_messages"),
    do_rpc: sum("do_rpc"),
    do_wakes: sum("do_wakes"),
    do_requests_est: Math.round(sum("ws_messages") / ASSUME.wsMessagesPerRequest) + sum("ws_connects") + sum("do_rpc") + sum("do_alarms"),
    do_active_seconds_est: Math.round((sum("do_events") * ASSUME.activeSecPerEvent + sum("do_wakes") * ASSUME.activeSecPerWake) * 100) / 100,
    do_rows_written_est: sum("do_rows_written"),
    do_wakes_offhours: off,
    do_wakes_offhours_max: offMax,
    tickets: sum("tickets"),
    calls: sum("calls"),
    push_sent: sum("push_sent"),
    push_failed: sum("push_failed"),
    r2_bytes: r2,
    d1_history_rows: hist,
    est_cost_usd: 0,
  };
  d.est_cost_usd = estDayCost(d, daysInMonth).total;
  return d;
}

const parseHours = (s: string | null): BusinessHour[] => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** 彙總一個 UTC 日（先刪後寫，冪等）。storeIds 省略＝全部門店（含 _platform）。回傳寫入列數。 */
export async function rollupDay(env: Env, date: string, opts: { storeIds?: string[] } = {}): Promise<number> {
  const start = dayStart(date);
  const [hourlyR, storesR, r2R, histR] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM usage_hourly WHERE hour_start >= ? AND hour_start < ?").bind(start, start + DAY),
    env.DB.prepare("SELECT id, timezone, business_hours, deleted_at FROM stores"),
    env.DB.prepare("SELECT owner_id, SUM(bytes) AS b FROM ad_assets WHERE owner_type='store' AND status='ready' GROUP BY owner_id"),
    env.DB.prepare("SELECT store_id, count(*) AS n FROM tickets_history GROUP BY store_id"),
  ]);
  const hourly = new Map<string, any[]>();
  for (const r of hourlyR.results as any[]) hourly.set(r.store_id, [...(hourly.get(r.store_id) ?? []), r]);
  const stores = new Map((storesR.results as any[]).map((s) => [s.id, s]));
  const r2 = new Map((r2R.results as any[]).map((x) => [x.owner_id, x.b as number]));
  const hist = new Map((histR.results as any[]).map((x) => [x.store_id, x.n as number]));
  let ids = [...new Set([...hourly.keys(), ...[...stores.values()].filter((s) => !s.deleted_at).map((s) => s.id)])];
  if (opts.storeIds) ids = opts.storeIds;
  const daysInMonth = monthDates(date.slice(0, 7)).length;
  const rows = ids.map((id) => {
    const s = stores.get(id);
    return dailyFromHourly(id, date, hourly.get(id) ?? [], s?.timezone ?? null, parseHours(s?.business_hours ?? null), r2.get(id) ?? 0, hist.get(id) ?? 0, daysInMonth);
  });
  await writeDaily(env, rows);
  return rows.length;
}

async function writeDaily(env: Env, rows: DailyRow[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO usage_daily(${DAILY_COLS.join(",")})
         SELECT ${DAILY_COLS.map((c) => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?)`,
      ).bind(JSON.stringify(rows.slice(i, i + 200))),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * 查詢時補算：區間內「有小時資料、但該店該日沒有日彙總」的過去日子（不含今天）。
 * 該日完全沒有日彙總 → 全店重算（無活動的門店也有一列 0）；否則只算缺的門店。
 */
export async function ensureDaily(env: Env, from: string, to: string, now: number): Promise<string[]> {
  const last = utcDate(now - DAY);
  const end = to < last ? to : last;
  if (from > end) return [];
  const [miss, have] = await env.DB.batch([
    env.DB.prepare(
      `SELECT DISTINCT h.store_id AS s, strftime('%Y-%m-%d', h.hour_start / 1000, 'unixepoch') AS d FROM usage_hourly h
       WHERE h.hour_start >= ? AND h.hour_start < ?
       AND NOT EXISTS (SELECT 1 FROM usage_daily u WHERE u.store_id = h.store_id AND u.date = strftime('%Y-%m-%d', h.hour_start / 1000, 'unixepoch'))`,
    ).bind(dayStart(from), dayStart(end) + DAY),
    env.DB.prepare("SELECT DISTINCT date FROM usage_daily WHERE date BETWEEN ? AND ?").bind(from, end),
  ]);
  const haveDates = new Set((have.results as any[]).map((x) => x.date));
  const byDate = new Map<string, string[]>();
  for (const r of miss.results as any[]) byDate.set(r.d, [...(byDate.get(r.d) ?? []), r.s]);
  const dates = [...byDate.keys()].sort();
  for (const date of dates) await rollupDay(env, date, haveDates.has(date) ? { storeIds: byDate.get(date) } : {});
  return dates;
}

// ---------- 每月＋分攤 ----------

export const LINE_ITEMS = [
  "workers_base",
  "workers_requests",
  "workers_cpu",
  "do_requests",
  "do_duration",
  "do_storage",
  "d1",
  "kv",
  "r2",
  "queues",
  "analytics_engine",
  "other",
] as const;
export type LineItem = (typeof LINE_ITEMS)[number];

export interface MonthRow {
  store_id: string;
  month: string;
  active_days: number;
  api_requests: number;
  api_errors: number;
  ws_connects: number;
  ws_messages: number;
  do_requests_est: number;
  do_active_seconds_est: number;
  do_rows_written_est: number;
  do_wakes_offhours: number;
  tickets: number;
  calls: number;
  push_sent: number;
  push_failed: number;
  r2_byte_days: number;
  est_cost_usd: number;
  allocated_cost_usd: number | null;
}

export function monthFromDaily(storeId: string, month: string, days: DailyRow[]): MonthRow {
  const sum = (k: keyof DailyRow) => days.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    store_id: storeId,
    month,
    active_days: days.filter((d) => d.tickets > 0 || d.api_requests > 0 || d.ws_connects > 0).length,
    api_requests: sum("api_requests"),
    api_errors: sum("api_errors"),
    ws_connects: sum("ws_connects"),
    ws_messages: sum("ws_messages"),
    do_requests_est: sum("do_requests_est"),
    do_active_seconds_est: Math.round(sum("do_active_seconds_est") * 100) / 100,
    do_rows_written_est: sum("do_rows_written_est"),
    do_wakes_offhours: sum("do_wakes_offhours"),
    tickets: sum("tickets"),
    calls: sum("calls"),
    push_sent: sum("push_sent"),
    push_failed: sum("push_failed"),
    r2_byte_days: sum("r2_bytes"),
    est_cost_usd: Math.round(sum("est_cost_usd") * 1e6) / 1e6,
    allocated_cost_usd: null,
  };
}

/** 12 §5 分攤依據。 */
const BASIS: Record<Exclude<LineItem, "workers_base">, (m: MonthRow) => number> = {
  workers_requests: (m) => m.api_requests,
  workers_cpu: (m) => m.api_requests,
  kv: (m) => m.api_requests,
  analytics_engine: (m) => m.api_requests,
  do_requests: (m) => m.do_requests_est,
  do_duration: (m) => m.do_active_seconds_est,
  do_storage: (m) => m.do_rows_written_est,
  d1: (m) => m.tickets,
  r2: (m) => m.r2_byte_days,
  queues: (m) => m.push_sent + m.tickets / ASSUME.historyBatch,
  other: (m) => m.est_cost_usd,
};

/**
 * 依實際帳單分攤：Σ 項目金額 × 店用量 / 全部用量。Workers 月費由「當月活躍的付費門店」平均分攤；
 * 內部門店（features.internal）與 _platform 列照用量分攤但不分月費（列為「平台」，12 §5）。
 * 某項全部用量為 0 時改依估算成本占比，再為 0 則由活躍付費門店平均分攤（金額不會消失）。
 */
export function allocate(rows: MonthRow[], billing: Partial<Record<LineItem, number>>, internal: Set<string>): Map<string, number> {
  const out = new Map(rows.map((r) => [r.store_id, 0]));
  const paying = rows.filter((r) => r.active_days > 0 && r.store_id !== PLATFORM && !internal.has(r.store_id));
  const even = (amt: number) => {
    const target = paying.length ? paying : rows;
    for (const r of target) out.set(r.store_id, out.get(r.store_id)! + amt / Math.max(1, target.length));
  };
  for (const item of LINE_ITEMS) {
    const amt = billing[item];
    if (!amt) continue;
    if (item === "workers_base") {
      even(amt);
      continue;
    }
    for (const basis of [BASIS[item], BASIS.other]) {
      const total = rows.reduce((a, r) => a + basis(r), 0);
      if (total > 0) {
        for (const r of rows) out.set(r.store_id, out.get(r.store_id)! + (amt * basis(r)) / total);
        break;
      }
      if (basis === BASIS.other) even(amt);
    }
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 1e6) / 1e6);
  return out;
}

export interface StoreMeta {
  id: string;
  name: string;
  code: string;
  internal: boolean;
  deleted: boolean;
}

export interface MonthReport {
  month: string;
  rows: (MonthRow & { name: string; code: string; internal: boolean; deleted: boolean })[];
  billing: { items: Partial<Record<LineItem, number>>; totalUsd: number | null; enteredAt: number | null; enteredBy: string | null };
  overview: { actualUsd: number | null; estUsd: number; activeStores: number; perStoreUsd: number | null };
  complete: boolean;
}

/** 某月報表：日彙總（缺的補算）→ 每店月加總 → 有帳單時分攤。總後台頁、CSV 與月結 Cron 共用同一個計算。 */
export async function buildMonth(env: Env, month: string, now: number): Promise<MonthReport> {
  const dates = monthDates(month);
  await ensureDaily(env, dates[0], dates.at(-1)!, now);
  const [dailyR, storesR, billR] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM usage_daily WHERE date BETWEEN ? AND ? ORDER BY date").bind(dates[0], dates.at(-1)),
    env.DB.prepare("SELECT id, name, code, features, deleted_at FROM stores"),
    env.DB.prepare("SELECT * FROM billing_inputs WHERE month=?").bind(month),
  ]);
  const byStore = new Map<string, DailyRow[]>();
  for (const r of dailyR.results as any[]) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r]);
  const meta = new Map<string, StoreMeta>();
  for (const s of storesR.results as any[]) {
    let f: any = {};
    try {
      f = JSON.parse(s.features ?? "{}");
    } catch {
      /* ignore */
    }
    meta.set(s.id, { id: s.id, name: s.name, code: s.code, internal: !!f.internal, deleted: !!s.deleted_at });
  }
  const rows = [...byStore].map(([id, days]) => monthFromDaily(id, month, days));
  const items: Partial<Record<LineItem, number>> = {};
  let enteredAt: number | null = null;
  let enteredBy: string | null = null;
  for (const b of billR.results as any[]) {
    if (b.source !== "invoice") continue;
    items[b.line_item as LineItem] = b.amount_usd;
    if (!enteredAt || b.entered_at > enteredAt) (enteredAt = b.entered_at), (enteredBy = b.entered_by);
  }
  const total = Object.values(items).reduce((a, b) => a + (b ?? 0), 0);
  const hasBill = Object.keys(items).length > 0;
  const internal = new Set([...meta.values()].filter((m) => m.internal).map((m) => m.id));
  if (hasBill) {
    const alloc = allocate(rows, items, internal);
    for (const r of rows) r.allocated_cost_usd = alloc.get(r.store_id) ?? 0;
  }
  const out = rows.map((r) => {
    const m = meta.get(r.store_id);
    return { ...r, name: m?.name ?? (r.store_id === PLATFORM ? "平台（未歸屬門店）" : r.store_id), code: m?.code ?? "", internal: r.store_id === PLATFORM || !!m?.internal, deleted: !!m?.deleted };
  });
  const activeStores = out.filter((r) => !r.internal && r.active_days > 0).length;
  const estUsd = Math.round(out.reduce((a, r) => a + r.est_cost_usd, 0) * 1e6) / 1e6;
  const actualUsd = hasBill ? Math.round(total * 1e6) / 1e6 : null;
  return {
    month,
    rows: out,
    billing: { items, totalUsd: actualUsd, enteredAt, enteredBy },
    overview: { actualUsd, estUsd, activeStores, perStoreUsd: activeStores ? Math.round(((actualUsd ?? estUsd) / activeStores) * 1e6) / 1e6 : null },
    complete: dates.at(-1)! < utcDate(now),
  };
}

const MONTH_COLS: (keyof MonthRow)[] = [
  "store_id", "month", "active_days", "api_requests", "api_errors", "ws_connects", "ws_messages", "do_requests_est", "do_active_seconds_est", "do_rows_written_est",
  "do_wakes_offhours", "tickets", "calls", "push_sent", "push_failed", "r2_byte_days", "est_cost_usd", "allocated_cost_usd",
];

/** 月結：寫 usage_monthly（先刪後寫）。 */
export async function persistMonth(env: Env, report: MonthReport): Promise<number> {
  const rows = report.rows.map((r) => Object.fromEntries(MONTH_COLS.map((c) => [c, r[c]])));
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM usage_monthly WHERE month=?").bind(report.month)];
  for (let i = 0; i < rows.length; i += 200) {
    stmts.push(
      env.DB.prepare(`INSERT INTO usage_monthly(${MONTH_COLS.join(",")}) SELECT ${MONTH_COLS.map((c) => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?)`).bind(
        JSON.stringify(rows.slice(i, i + 200)),
      ),
    );
  }
  await env.DB.batch(stmts);
  return rows.length;
}

export const prevMonth = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

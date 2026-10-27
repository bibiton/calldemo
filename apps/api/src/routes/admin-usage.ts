/**
 * 總後台「用量與成本」（12-usage-metering §6）：月總覽、排行、每店用量頁、帳單輸入／分攤、CSV。
 * 讀 D1 彙總表（缺的過去日子即時補算）；「今日」API 請求數在 Analytics Engine 已設定時即時查詢。不喚醒 DO。
 */
import type { Hono } from "hono";
import { ulid } from "@qcs/shared";
import { storeAlerts } from "../usage/alerts";
import { aeToday, type AeFetch } from "../usage/ae";
import { PRICE_DATE } from "../usage/prices";
import { LINE_ITEMS, buildMonth, datesBetween, ensureDaily, isMonth, persistMonth, utcDate, type DailyRow, type LineItem, type MonthReport } from "../usage/rollup";
import { err, type AppEnv, type C, type Deps } from "./common";

const DAY = 86400_000;
const TREND_DAYS = 30;
const SORTS = ["allocated", "tickets", "per_ticket"] as const;

const cost = (r: { allocated_cost_usd: number | null; est_cost_usd: number }) => r.allocated_cost_usd ?? r.est_cost_usd;

/** CSV 欄位：跳脫引號／逗號／換行；= + - @ 開頭加單引號，避免試算表當成公式執行。 */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function registerUsageRoutes(r: Hono<AppEnv>, deps: Deps & { aeFetch: AeFetch }): void {
  const { now } = deps;
  const curMonth = () => utcDate(now()).slice(0, 7);

  async function trends(c: C, ids: string[]) {
    const to = utcDate(now());
    const from = utcDate(now() - (TREND_DAYS - 1) * DAY);
    await ensureDaily(c.env, from, to, now());
    const rows = await c.env.DB.prepare("SELECT store_id, date, tickets, api_requests, est_cost_usd FROM usage_daily WHERE date BETWEEN ? AND ?").bind(from, to).all<any>();
    const by = new Map<string, Map<string, any>>();
    for (const x of rows.results) {
      if (!by.has(x.store_id)) by.set(x.store_id, new Map());
      by.get(x.store_id)!.set(x.date, x);
    }
    const dates = datesBetween(from, to);
    return new Map(
      ids.map((id) => [id, dates.map((d) => ({ date: d, tickets: by.get(id)?.get(d)?.tickets ?? 0, apiRequests: by.get(id)?.get(d)?.api_requests ?? 0, estCostUsd: by.get(id)?.get(d)?.est_cost_usd ?? 0 }))]),
    );
  }

  async function adUsage(c: C) {
    const rows = await c.env.DB.prepare(
      "SELECT s.id, s.ad_quota_bytes AS quota, COALESCE((SELECT SUM(bytes) FROM ad_assets a WHERE a.owner_type='store' AND a.owner_id=s.id AND a.status='ready'),0) AS used FROM stores s",
    ).all<any>();
    return new Map(rows.results.map((x) => [x.id, { used: x.used as number, quota: x.quota as number }]));
  }

  r.get("/usage", async (c) => {
    const month = c.req.query("month") ?? curMonth();
    if (!isMonth(month)) return err(c, 422, "INVALID");
    const sort = (SORTS as readonly string[]).includes(c.req.query("sort") ?? "") ? (c.req.query("sort") as (typeof SORTS)[number]) : "allocated";
    const rep = await buildMonth(c.env, month, now());
    const ids = rep.rows.map((x) => x.store_id);
    const [trend, alerts, ads] = await Promise.all([trends(c, ids), storeAlerts(c.env, ids, now()), adUsage(c)]);
    const stores = rep.rows.map((m) => ({
      storeId: m.store_id,
      name: m.name,
      code: m.code,
      internal: m.internal,
      deleted: m.deleted,
      month: m,
      perTicketUsd: m.tickets ? cost(m) / m.tickets : null,
      trend: trend.get(m.store_id) ?? [],
      alerts: alerts.get(m.store_id) ?? [],
      adBytes: ads.get(m.store_id)?.used ?? 0,
      adQuotaBytes: ads.get(m.store_id)?.quota ?? 0,
    }));
    const key = (s: (typeof stores)[number]) => (sort === "tickets" ? s.month.tickets : sort === "per_ticket" ? (s.perTicketUsd ?? -1) : cost(s.month));
    stores.sort((a, b) => key(b) - key(a) || a.code.localeCompare(b.code));
    return c.json({ month, complete: rep.complete, overview: rep.overview, billing: rep.billing, priceDate: PRICE_DATE, sort, stores });
  });

  r.get("/usage/stores/:id", async (c) => {
    const id = c.req.param("id");
    const s = await c.env.DB.prepare("SELECT id, name, code, timezone, business_hours FROM stores WHERE id=?").bind(id).first<any>();
    if (!s) return err(c, 404, "STORE_NOT_FOUND");
    const to = utcDate(now());
    const from = utcDate(now() - (TREND_DAYS - 1) * DAY);
    await ensureDaily(c.env, from, to, now());
    const rows = await c.env.DB.prepare("SELECT * FROM usage_daily WHERE store_id=? AND date BETWEEN ? AND ? ORDER BY date").bind(id, from, to).all<DailyRow>();
    const byDate = new Map(rows.results.map((x) => [x.date, x]));
    const days = datesBetween(from, to).map((d) => byDate.get(d) ?? ({ store_id: id, date: d, tickets: 0, api_requests: 0, ws_messages: 0, push_sent: 0, push_failed: 0, do_requests_est: 0, do_active_seconds_est: 0, do_wakes_offhours: 0, r2_bytes: 0, est_cost_usd: 0 } as Partial<DailyRow>));
    const rep = await buildMonth(c.env, curMonth(), now());
    const month = rep.rows.find((x) => x.store_id === id) ?? null;
    let today: { apiRequests: number } | null = null;
    try {
      const t = await aeToday(c.env, now(), deps.aeFetch);
      if (t) today = { apiRequests: t.get(id) ?? 0 };
    } catch (e) {
      console.error("AE today failed", String(e));
    }
    const alerts = (await storeAlerts(c.env, [id], now())).get(id) ?? [];
    return c.json({ store: { id: s.id, name: s.name, code: s.code, timezone: s.timezone }, days, month, alerts, today, priceDate: PRICE_DATE });
  });

  r.get("/billing", async (c) => {
    const month = c.req.query("month") ?? curMonth();
    if (!isMonth(month)) return err(c, 422, "INVALID");
    const rows = await c.env.DB.prepare("SELECT * FROM billing_inputs WHERE month=? AND source='invoice'").bind(month).all<any>();
    const items: Partial<Record<LineItem, number>> = {};
    let enteredAt: number | null = null;
    let enteredBy: string | null = null;
    for (const x of rows.results) {
      items[x.line_item as LineItem] = x.amount_usd;
      if (!enteredAt || x.entered_at > enteredAt) (enteredAt = x.entered_at), (enteredBy = x.entered_by);
    }
    return c.json({ month, items, lineItems: LINE_ITEMS, enteredAt, enteredBy });
  });

  r.put("/billing", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || !isMonth(b.month) || !b.items || typeof b.items !== "object" || Array.isArray(b.items)) return err(c, 422, "INVALID");
    const entries = Object.entries(b.items as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (!(LINE_ITEMS as readonly string[]).includes(k)) return err(c, 422, "INVALID", { field: k });
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000)) return err(c, 422, "INVALID", { field: k });
    }
    const who = c.get("platform").email;
    const stmts: D1PreparedStatement[] = entries.map(([k, v]) =>
      v === null
        ? c.env.DB.prepare("DELETE FROM billing_inputs WHERE month=? AND line_item=?").bind(b.month, k)
        : c.env.DB.prepare(
            "INSERT INTO billing_inputs(month,line_item,amount_usd,source,entered_by,entered_at) VALUES(?,?,?,'invoice',?,?) ON CONFLICT(month,line_item) DO UPDATE SET amount_usd=excluded.amount_usd, source='invoice', entered_by=excluded.entered_by, entered_at=excluded.entered_at",
          ).bind(b.month, k, Math.round((v as number) * 100) / 100, who, now()),
    );
    stmts.push(
      c.env.DB.prepare("INSERT INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target,detail) VALUES(?,?,?,?,?,?,?,?)").bind(
        ulid(now()), now(), "platform_admin", who, null, "billing.input", b.month, JSON.stringify(b.items),
      ),
    );
    await c.env.DB.batch(stmts);
    const rep = await buildMonth(c.env, b.month, now());
    if (rep.complete) await persistMonth(c.env, rep);
    return c.json({ ok: true, overview: rep.overview });
  });

  r.get("/usage/export.csv", async (c) => {
    const month = c.req.query("month") ?? curMonth();
    const gran = c.req.query("granularity") === "daily" ? "daily" : "monthly";
    if (!isMonth(month)) return err(c, 422, "INVALID");
    const rep: MonthReport = await buildMonth(c.env, month, now());
    const meta = new Map(rep.rows.map((x) => [x.store_id, x]));
    let body: string;
    if (gran === "monthly") {
      body = csv([
        ["門店碼", "門店", "月份", "活躍天數", "號碼數", "叫號數", "API 請求", "API 錯誤", "WS 連線", "WS 訊息", "DO 請求(估)", "DO 活躍秒(估)", "DO 寫入列(估)", "夜間喚醒", "推播", "推播失敗", "R2 GB-日", "估算成本(USD)", "分攤成本(USD)"],
        ...rep.rows.map((m) => [
          m.code || m.store_id, m.name, m.month, m.active_days, m.tickets, m.calls, m.api_requests, m.api_errors, m.ws_connects, m.ws_messages, m.do_requests_est,
          m.do_active_seconds_est, m.do_rows_written_est, m.do_wakes_offhours, m.push_sent, m.push_failed, (m.r2_byte_days / 1e9).toFixed(3),
          m.est_cost_usd.toFixed(6), m.allocated_cost_usd == null ? "" : m.allocated_cost_usd.toFixed(6),
        ]),
      ]);
    } else {
      const days = await c.env.DB.prepare("SELECT * FROM usage_daily WHERE date LIKE ? ORDER BY store_id, date").bind(`${month}-%`).all<DailyRow>();
      body = csv([
        ["門店碼", "門店", "日期", "號碼數", "叫號數", "API 請求", "API 錯誤", "WS 連線", "WS 訊息", "DO 請求(估)", "DO 活躍秒(估)", "DO 寫入列(估)", "夜間喚醒", "夜間單小時最多", "推播", "推播失敗", "廣告 MB", "歷史列數", "估算成本(USD)"],
        ...days.results.map((d) => {
          const m = meta.get(d.store_id);
          return [
            m?.code || d.store_id, m?.name ?? d.store_id, d.date, d.tickets, d.calls, d.api_requests, d.api_errors, d.ws_connects, d.ws_messages, d.do_requests_est,
            d.do_active_seconds_est, d.do_rows_written_est, d.do_wakes_offhours, d.do_wakes_offhours_max, d.push_sent, d.push_failed, (d.r2_bytes / 1048576).toFixed(1),
            d.d1_history_rows, d.est_cost_usd.toFixed(6),
          ];
        }),
      ]);
    }
    return new Response(body, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="usage-${month}-${gran}.csv"`, "cache-control": "no-store" },
    });
  });
}

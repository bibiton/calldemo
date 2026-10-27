/** 門店報表 API：今日（DO 即時）、區間（daily_stats，缺的日子即時補算）、CSV 匯出。 */
import type { Hono } from "hono";
import { businessDate } from "@qcs/shared";
import { computeDailyStats } from "../reports";
import { toCtx } from "../lib/store-ctx";
import { err, type AppEnv, type C } from "./common";
import type { AdminHelpers } from "./pairing";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 3600_000;
const MAX_DAYS = 31;

function dates(from: string, to: string): string[] | null {
  if (!YMD.test(from) || !YMD.test(to)) return null;
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || (b - a) / DAY + 1 > MAX_DAYS) return null;
  const out: string[] = [];
  for (let t = a; t <= b; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function dailyRows(c: C, h: AdminHelpers, ds: string[]) {
  const sid = c.get("admin").store_id;
  const rec = c.get("rec");
  const today = businessDate(h.deps.now(), rec.store.timezone);
  const have = new Set(
    (await c.env.DB.prepare(`SELECT DISTINCT business_date FROM daily_stats WHERE store_id=? AND business_date BETWEEN ? AND ?`).bind(sid, ds[0], ds.at(-1)).all<{ business_date: string }>()).results.map(
      (r) => r.business_date,
    ),
  );
  for (const d of ds) if (d < today && !have.has(d)) await computeDailyStats(c.env, sid, d, rec.store.timezone);
  const rows = await c.env.DB.prepare("SELECT * FROM daily_stats WHERE store_id=? AND business_date BETWEEN ? AND ? ORDER BY business_date, service_id").bind(sid, ds[0], ds.at(-1)).all<any>();
  const svcs = new Map(
    (await c.env.DB.prepare("SELECT id, name, prefix FROM services WHERE store_id=?").bind(sid).all<{ id: string; name: string; prefix: string }>()).results.map((s) => [s.id, s]),
  );
  return rows.results
    .map((r) => ({
      businessDate: r.business_date,
      serviceId: r.service_id,
      serviceName: svcs.get(r.service_id)?.name ?? "（已刪除）",
      prefix: svcs.get(r.service_id)?.prefix ?? "",
      issued: r.issued,
      done: r.done,
      skipped: r.skipped,
      noShow: r.no_show,
      cancelled: r.cancelled,
      avgWaitMs: r.avg_wait_ms,
      p90WaitMs: r.p90_wait_ms,
      avgServiceMs: r.avg_service_ms,
      peakHour: r.peak_hour,
    }))
    .sort((a, b) => (a.businessDate === b.businessDate ? a.prefix.localeCompare(b.prefix) : a.businessDate.localeCompare(b.businessDate)));
}

const mins = (ms: number | null) => (ms == null ? "" : (ms / 60_000).toFixed(1));
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function registerReportRoutes(r: Hono<AppEnv>, h: AdminHelpers): void {
  r.get("/reports/today", async (c) => {
    const sid = c.get("admin").store_id;
    return c.json(await h.deps.stub(c, sid).todayStats(await toCtx(c.env, c.get("rec"), false)));
  });

  r.get("/reports/daily", async (c) => {
    const ds = dates(c.req.query("from") ?? "", c.req.query("to") ?? "");
    if (!ds) return err(c, 422, "RANGE_INVALID", { maxDays: MAX_DAYS });
    return c.json({ rows: await dailyRows(c, h, ds) });
  });

  r.get("/reports/daily.csv", async (c) => {
    const ds = dates(c.req.query("from") ?? "", c.req.query("to") ?? "");
    if (!ds) return err(c, 422, "RANGE_INVALID", { maxDays: MAX_DAYS });
    const rows = await dailyRows(c, h, ds);
    const head = "日期,服務,取號數,完成,過號,未到,取消,完成率,平均等候(分),P90等候(分),平均服務(分),尖峰時段";
    const lines = rows.map((x) =>
      [
        x.businessDate,
        csvCell(`${x.prefix} ${x.serviceName}`.trim()),
        x.issued,
        x.done,
        x.skipped,
        x.noShow,
        x.cancelled,
        x.issued ? `${((x.done / x.issued) * 100).toFixed(1)}%` : "",
        mins(x.avgWaitMs),
        mins(x.p90WaitMs),
        mins(x.avgServiceMs),
        x.peakHour == null ? "" : `${String(x.peakHour).padStart(2, "0")}:00`,
      ].join(","),
    );
    // BOM：Excel 開啟中文不亂碼
    return new Response("﻿" + [head, ...lines].join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="report-${ds[0]}_${ds.at(-1)}.csv"`,
      },
    });
  });
}

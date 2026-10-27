import { useState } from "react";
import { api } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { bytes, monthLabel, num, shiftMonth, usd } from "../lib/format";
import type { Alert, MonthRow } from "../lib/types";
import { AlertList } from "../components/Alerts";
import { Spark } from "../components/Charts";
import { Button, Card, Empty, ErrorBox, Loading, Page, Sheet, useLoad } from "../ui";

interface UsageResp {
  month: string;
  complete: boolean;
  overview: { actualUsd: number | null; estUsd: number; activeStores: number; perStoreUsd: number | null };
  billing: { totalUsd: number | null; enteredAt: number | null; enteredBy: string | null };
  priceDate: string;
  stores: {
    storeId: string;
    name: string;
    code: string;
    internal: boolean;
    deleted: boolean;
    month: MonthRow;
    perTicketUsd: number | null;
    trend: { date: string; tickets: number }[];
    alerts: Alert[];
    adBytes: number;
    adQuotaBytes: number;
  }[];
}

const SORTS = [
  { v: "allocated", label: "成本" },
  { v: "tickets", label: "號碼數" },
  { v: "per_ticket", label: "每號成本" },
] as const;

export const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Usage() {
  const { query } = useRoute();
  const month = /^\d{4}-\d{2}$/.test(query.get("month") ?? "") ? query.get("month")! : thisMonth();
  const sort = query.get("sort") ?? "allocated";
  const [csv, setCsv] = useState(false);
  const { data, error, reload } = useLoad(() => api<UsageResp>(`/api/admin/usage?month=${month}&sort=${sort}`), [month, sort]);
  const go = (m: string, s = sort) => navigate(`/usage?month=${m}&sort=${s}`, true);
  const hasBill = data?.overview.actualUsd != null;

  return (
    <Page title="用量與成本" testId="usage">
      <div className="flex items-center justify-between gap-2">
        <button className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand ring-1 ring-slate-300 active:bg-slate-100" onClick={() => go(shiftMonth(month, -1))} aria-label="上個月" data-testid="prev-month">
          ‹
        </button>
        <h2 className="text-lg font-bold" data-testid="month">
          {monthLabel(month)}
        </h2>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand ring-1 ring-slate-300 active:bg-slate-100 disabled:opacity-30"
          onClick={() => go(shiftMonth(month, 1))}
          disabled={month >= thisMonth()}
          aria-label="下個月"
        >
          ›
        </button>
      </div>
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <Card testId="overview">
            <div className="grid grid-cols-2 gap-3">
              <Big label="帳號實際" value={hasBill ? usd(data.overview.actualUsd) : "未輸入"} muted={!hasBill} />
              <Big label="依單價估算" value={usd(data.overview.estUsd)} />
              <Big label="活躍門店" value={`${data.overview.activeStores} 家`} />
              <Big label={hasBill ? "每店平均（實際）" : "每店平均（估算）"} value={usd(data.overview.perStoreUsd)} />
            </div>
            <p className="mt-3 text-sm text-slate-500">
              {data.complete ? "本月已結束" : "本月進行中（到昨天為止）"}；估算不扣內含額度，單價查證日 <span className="whitespace-nowrap">{data.priceDate}</span>。
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button kind="secondary" onClick={() => navigate(`/billing?month=${month}`)} data-testid="go-billing">
                {hasBill ? "修改帳單" : "輸入帳單"}
              </Button>
              <Button kind="secondary" onClick={() => setCsv(true)} disabled={!data.stores.length} data-testid="export">
                匯出 CSV
              </Button>
            </div>
          </Card>
          <div className="flex items-center gap-2" role="tablist" aria-label="排序">
            <span className="shrink-0 text-sm text-slate-500">排序</span>
            {SORTS.map((s) => (
              <button
                key={s.v}
                role="tab"
                aria-selected={sort === s.v}
                onClick={() => go(month, s.v)}
                className={`min-h-11 flex-1 rounded-full px-2 text-base font-bold ${sort === s.v ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
                data-testid={`sort-${s.v}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {data.stores.length === 0 ? (
            <Empty title="這個月還沒有用量資料" text="每日 09:05（台灣時間）彙總前一天的用量。" />
          ) : (
            <ul className="flex flex-col gap-3" data-testid="usage-list">
              {data.stores.map((s, i) => (
                <li key={s.storeId}>
                  <button
                    className="flex w-full flex-col gap-2 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
                    onClick={() => navigate(`/usage/stores/${encodeURIComponent(s.storeId)}`)}
                    data-testid={`usage-${s.code || s.storeId}`}
                  >
                    <div className="flex w-full items-start gap-2">
                      <span className="w-6 shrink-0 pt-0.5 text-base font-bold text-slate-400 tabular-nums">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-lg font-bold">{s.name}</span>
                        <span className="block text-sm text-slate-500">{[s.code, s.internal ? "不分攤月費" : "", s.deleted ? "已刪除" : ""].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-lg font-bold tabular-nums">{usd(s.month.allocated_cost_usd ?? s.month.est_cost_usd)}</span>
                        <span className="block text-xs text-slate-500">{s.month.allocated_cost_usd != null ? `估 ${usd(s.month.est_cost_usd)}` : "估算"}</span>
                      </span>
                    </div>
                    <div className="flex w-full items-center gap-3 pl-8">
                      <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5 text-sm text-slate-600 tabular-nums">
                        <span className="whitespace-nowrap">號 {num(s.month.tickets)}</span>
                        <span className="whitespace-nowrap">API {compact(s.month.api_requests)}</span>
                        <span className="whitespace-nowrap">每千號 {s.perTicketUsd == null ? "—" : usd(s.perTicketUsd * 1000)}</span>
                        <span className="whitespace-nowrap">廣告 {bytes(s.adBytes)}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <Spark values={s.trend.map((t) => t.tickets)} label={`${s.name} 近 30 日每日號碼數`} />
                        <span className="text-xs text-slate-500">近 30 日號碼</span>
                      </span>
                    </div>
                    {s.alerts.length > 0 && (
                      <div className="w-full pl-8">
                        <AlertList alerts={s.alerts} compact />
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {csv && (
        <Sheet title="匯出 CSV" onClose={() => setCsv(false)} testId="csv-sheet">
          <p className="text-base text-slate-600">{monthLabel(month)}，Excel 可直接開啟（UTF-8）。</p>
          <a className="flex min-h-12 items-center justify-center rounded-xl bg-brand px-4 text-base font-bold text-white" href={`/api/admin/usage/export.csv?month=${month}&granularity=monthly`} download data-testid="csv-monthly">
            每店每月（{data?.stores.length ?? 0} 列）
          </a>
          <a className="flex min-h-12 items-center justify-center rounded-xl bg-white px-4 text-base font-bold text-brand ring-1 ring-slate-300" href={`/api/admin/usage/export.csv?month=${month}&granularity=daily`} download data-testid="csv-daily">
            每店每日
          </a>
        </Sheet>
      )}
    </Page>
  );
}

const compact = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : num(n));

function Big({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`truncate text-xl font-bold tabular-nums ${muted ? "text-slate-400" : "text-slate-900"}`}>{value}</p>
    </div>
  );
}

import { useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { bytes, num, usd } from "../lib/format";
import type { Alert, MonthRow } from "../lib/types";
import { AlertList } from "../components/Alerts";
import { DayBars } from "../components/Charts";
import { Button, Card, ErrorBox, Loading, Page, useLoad } from "../ui";

interface Day {
  date: string;
  tickets: number;
  api_requests: number;
  ws_messages: number;
  push_sent: number;
  push_failed: number;
  do_requests_est: number;
  do_active_seconds_est: number;
  do_wakes_offhours: number;
  r2_bytes: number;
  est_cost_usd: number;
}
interface Resp {
  store: { id: string; name: string; code: string };
  days: Day[];
  month: MonthRow | null;
  alerts: Alert[];
  today: { apiRequests: number } | null;
  priceDate: string;
}

const METRICS = [
  { k: "tickets", label: "每日號碼數", fmt: (n: number) => `${num(n)} 號` },
  { k: "est_cost_usd", label: "每日估算成本", fmt: usd },
  { k: "api_requests", label: "每日 API 請求", fmt: (n: number) => num(n) },
] as const;

export function StoreUsage({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => api<Resp>(`/api/admin/usage/stores/${encodeURIComponent(id)}`), [id]);
  const [metric, setMetric] = useState<(typeof METRICS)[number]["k"]>("tickets");
  if (error) return <Page title="門店用量" back="/usage"><ErrorBox text={error} onRetry={reload} /></Page>;
  if (!data) return <Page title="門店用量" back="/usage"><Loading /></Page>;
  const m = data.month;
  const met = METRICS.find((x) => x.k === metric)!;
  const recent = [...data.days].reverse();
  const today = data.days.at(-1)?.date;

  return (
    <Page title={`${data.store.name} 用量`} back="/usage" testId="store-usage">
      <AlertList alerts={data.alerts} />
      <Card testId="today">
        <h2 className="text-base font-bold text-slate-500">今日（UTC）</h2>
        {data.today ? (
          <p className="mt-1 text-2xl font-bold tabular-nums">API 請求 {num(data.today.apiRequests)}</p>
        ) : (
          <p className="mt-1 text-base text-slate-600">即時數字部署後才有（Analytics Engine）。下方為已彙總的每日資料。</p>
        )}
      </Card>
      <Card testId="month-totals">
        <h2 className="mb-3 text-base font-bold text-slate-500">本月累計（到昨天）</h2>
        {m ? (
          <dl className="grid grid-cols-2 gap-2">
            <Kv k="號碼數" v={num(m.tickets)} />
            <Kv k="叫號次數" v={num(m.calls)} />
            <Kv k="API 請求" v={num(m.api_requests)} />
            <Kv k="WS 訊息" v={num(m.ws_messages)} />
            <Kv k="DO 活躍秒（估）" v={num(m.do_active_seconds_est)} />
            <Kv k="推播（失敗）" v={`${num(m.push_sent)}（${num(m.push_failed)}）`} />
            <Kv k="夜間喚醒" v={num(m.do_wakes_offhours)} warn={m.do_wakes_offhours > 0} />
            <Kv k="廣告用量" v={bytes(data.days.at(-2)?.r2_bytes ?? 0)} />
            <Kv k="估算成本" v={usd(m.est_cost_usd)} />
            <Kv k="分攤成本" v={m.allocated_cost_usd == null ? "未輸入帳單" : usd(m.allocated_cost_usd)} />
          </dl>
        ) : (
          <p className="text-base text-slate-600">本月還沒有彙總資料。</p>
        )}
      </Card>
      <Card>
        <div className="mb-3 grid grid-cols-3 gap-2" role="tablist" aria-label="圖表">
          {METRICS.map((x) => (
            <button
              key={x.k}
              role="tab"
              aria-selected={metric === x.k}
              onClick={() => setMetric(x.k)}
              className={`min-h-11 rounded-full px-1 text-sm font-bold ${metric === x.k ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
            >
              {x.label.replace("每日", "")}
            </button>
          ))}
        </div>
        <DayBars days={data.days} value={(d: Day) => Number(d[metric]) || 0} format={met.fmt} label={`${met.label}（近 30 天）`} />
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-bold">每日明細</h2>
        <ul className="flex flex-col divide-y divide-slate-100" data-testid="day-list">
          {recent.map((d) => (
            <li key={d.date} className="flex items-center gap-3 py-2.5">
              <span className="w-14 shrink-0 text-base font-bold tabular-nums">{d.date.slice(5).replace("-", "/")}</span>
              {d.date === today ? (
                <span className="min-w-0 flex-1 text-sm text-slate-500">今天（明天 09:05 彙總）</span>
              ) : (
                <span className="flex min-w-0 flex-1 flex-wrap gap-x-2.5 text-sm text-slate-600 tabular-nums">
                  <span className="whitespace-nowrap">號 {num(d.tickets)}</span>
                  <span className="whitespace-nowrap">API {num(d.api_requests)}</span>
                  <span className="whitespace-nowrap">推播 {num(d.push_sent)}</span>
                  {d.do_wakes_offhours > 0 && <span className="whitespace-nowrap font-bold text-amber-900">夜間喚醒 {num(d.do_wakes_offhours)}</span>}
                </span>
              )}
              <span className="shrink-0 text-base font-bold tabular-nums">{d.date === today ? "—" : usd(d.est_cost_usd)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-slate-500">
          日期為 UTC（與 Cloudflare 計費日一致）。單價查證日 <span className="whitespace-nowrap">{data.priceDate}</span>。
        </p>
      </Card>
      <Button kind="secondary" onClick={() => navigate(`/stores/${encodeURIComponent(id)}`)}>
        門店設定
      </Button>
    </Page>
  );
}

function Kv({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
      <dt className="text-sm text-slate-500">{k}</dt>
      <dd className={`truncate text-lg font-bold tabular-nums ${warn ? "text-amber-900" : "text-slate-900"}`}>{v}</dd>
    </div>
  );
}

import { useState } from "react";
import { api, freshToken } from "../lib/api";
import { API_BASE } from "../lib/env";
import { Button, Card, Empty, ErrorBox, Loading, Page, toast, useLoad } from "../ui";

interface Today {
  businessDate: string;
  services: { serviceId: string; name: string; prefix: string; issued: number; waiting: number; called: number; done: number; skipped: number; noShow: number; cancelled: number; avgWaitMs: number | null }[];
}
interface Row {
  businessDate: string;
  serviceId: string;
  serviceName: string;
  prefix: string;
  issued: number;
  done: number;
  skipped: number;
  noShow: number;
  cancelled: number;
  avgWaitMs: number | null;
  p90WaitMs: number | null;
  avgServiceMs: number | null;
  peakHour: number | null;
}

const min = (ms: number | null) => (ms == null ? "—" : `${(ms / 60_000).toFixed(1)} 分`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function range(days: number, today: string) {
  const end = new Date(today + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: ymd(start), to: ymd(end) };
}

export function Reports() {
  const today = useLoad(() => api<Today>("/api/store/reports/today"));
  const [days, setDays] = useState(7);
  const bd = today.data?.businessDate;
  const hist = useLoad(async () => (bd ? api<{ rows: Row[] }>(`/api/store/reports/daily?from=${range(days, bd).from}&to=${range(days, bd).to}`) : null), [bd, days]);
  const [dl, setDl] = useState(false);

  async function csv() {
    if (!bd) return;
    setDl(true);
    try {
      const r = range(days, bd);
      const token = await freshToken();
      const res = await fetch(`${API_BASE}/api/store/reports/daily.csv?from=${r.from}&to=${r.to}`, { headers: { authorization: `Bearer ${token}` }, credentials: "include" });
      if (!res.ok) throw new Error();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = `叫號報表_${r.from}_${r.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch {
      toast("匯出失敗，請稍後再試", "err");
    }
    setDl(false);
  }

  const t = today.data?.services ?? [];
  const sum = (k: "issued" | "waiting" | "done") => t.reduce((a, s) => a + s[k], 0);
  const rows = hist.data?.rows ?? [];
  const byDate = [...new Set(rows.map((r) => r.businessDate))].sort().reverse();
  const tot = rows.reduce((a, r) => ({ issued: a.issued + r.issued, done: a.done + r.done }), { issued: 0, done: 0 });

  return (
    <Page title="報表" testId="reports">
      <h2 className="text-base font-bold text-slate-600">今日{bd ? `（${bd}）` : ""}</h2>
      {today.error && <ErrorBox text={today.error} onRetry={today.reload} />}
      {!today.data && !today.error && <Loading />}
      {today.data && (
        <>
          <section className="grid grid-cols-3 gap-2" data-testid="today-totals">
            {[
              ["取號", sum("issued")],
              ["等候中", sum("waiting")],
              ["已完成", sum("done")],
            ].map(([k, n]) => (
              <Card key={k} className="!p-3 text-center">
                <p className="text-sm text-slate-500">{k}</p>
                <p className="text-3xl font-black text-brand tabular-nums">{n}</p>
              </Card>
            ))}
          </section>
          <Card className="!p-0">
            <ul className="divide-y divide-slate-100">
              {t.map((s) => (
                <li key={s.serviceId} className="px-4 py-3">
                  <p className="text-base font-bold">
                    {s.prefix} {s.name}
                  </p>
                  <p className="text-sm text-slate-600 tabular-nums">
                    取號 {s.issued} · 叫號中 {s.called} · 完成 {s.done} · 過號 {s.skipped} · 取消 {s.cancelled}
                  </p>
                  <p className="text-sm text-slate-500">平均等候 {min(s.avgWaitMs)}</p>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-600">歷史</h2>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-200 p-1" role="radiogroup" aria-label="期間">
          {[7, 30].map((d) => (
            <button key={d} role="radio" aria-checked={days === d} className={`min-h-11 rounded-lg px-4 text-base font-bold ${days === d ? "bg-white text-brand shadow" : "text-slate-600"}`} onClick={() => setDays(d)} data-testid={`days-${d}`}>
              近 {d} 天
            </button>
          ))}
        </div>
      </div>
      {hist.error && <ErrorBox text={hist.error} onRetry={hist.reload} />}
      {!hist.data && !hist.error && <Loading />}
      {hist.data && rows.length === 0 && <Empty title="這段期間沒有資料" text="營業日結束後的隔天凌晨會結算前一天的數字。" />}
      {hist.data && rows.length > 0 && (
        <>
          <Card testId="history-summary">
            <p className="text-base text-slate-600">
              共取號 <b className="text-xl text-slate-900 tabular-nums">{tot.issued}</b> 張，完成率 <b className="text-xl text-slate-900 tabular-nums">{tot.issued ? ((tot.done / tot.issued) * 100).toFixed(1) : "0"}%</b>
            </p>
          </Card>
          {byDate.map((d) => (
            <Card key={d} className="!p-0" testId={`day-${d}`}>
              <p className="border-b border-slate-100 px-4 py-2 text-base font-bold">{d}</p>
              <ul className="divide-y divide-slate-100">
                {rows
                  .filter((r) => r.businessDate === d)
                  .map((r) => (
                    <li key={r.serviceId} className="px-4 py-2">
                      <p className="flex justify-between gap-2 text-base">
                        <span className="font-bold">
                          {r.prefix} {r.serviceName}
                        </span>
                        <span className="tabular-nums">
                          {r.done}/{r.issued} 完成
                        </span>
                      </p>
                      <p className="text-sm text-slate-500 tabular-nums">
                        等候 平均 {min(r.avgWaitMs)}／P90 {min(r.p90WaitMs)} · 尖峰 {r.peakHour == null ? "—" : `${String(r.peakHour).padStart(2, "0")}:00`}
                      </p>
                    </li>
                  ))}
              </ul>
            </Card>
          ))}
        </>
      )}
      <Button kind="secondary" onClick={() => void csv()} disabled={dl || !bd} data-testid="csv">
        {dl ? "匯出中…" : `⬇ 匯出近 ${days} 天 CSV`}
      </Button>
    </Page>
  );
}

import { useState } from "react";
import { api } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { date, usd } from "../lib/format";
import { STATUS_TEXT, STATUS_TONE, type StoreStatus, type StoreSummary } from "../lib/types";
import { AlertList } from "../components/Alerts";
import { Badge, Button, Empty, ErrorBox, inputCls, Loading, Page, useLoad } from "../ui";

const FILTERS: { v: "all" | StoreStatus; label: string }[] = [
  { v: "all", label: "全部" },
  { v: "active", label: "營業中" },
  { v: "suspended", label: "已停用" },
  { v: "expired", label: "已到期" },
  { v: "deleted", label: "已刪除" },
];

export function Stores() {
  const { query } = useRoute();
  const [q, setQ] = useState(query.get("q") ?? "");
  const status = (query.get("status") ?? "all") as "all" | StoreStatus;
  const [term, setTerm] = useState(q);
  const { data, error, reload } = useLoad(
    () => api<{ stores: StoreSummary[]; month: string }>(`/api/admin/stores?status=${status}${term ? `&q=${encodeURIComponent(term)}` : ""}`),
    [status, term],
  );
  const setStatus = (v: string) => navigate(`/?status=${v}${term ? `&q=${encodeURIComponent(term)}` : ""}`, true);
  const warn = data?.stores.filter((s) => s.alerts?.length).length ?? 0;

  return (
    <Page
      title="門店"
      testId="stores"
      footer={
        <Button className="w-full" onClick={() => navigate("/stores/new")} data-testid="new-store">
          ＋ 建立門店
        </Button>
      }
    >
      <form
        className="flex gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <input className={inputCls} type="search" placeholder="搜尋門店名稱或門店碼" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋門店" data-testid="search" />
        <Button kind="secondary" type="submit" className="shrink-0">
          搜尋
        </Button>
      </form>
      <div className="grid grid-cols-5 gap-1.5" role="tablist" aria-label="狀態篩選">
        {FILTERS.map((f) => (
          <button
            key={f.v}
            role="tab"
            aria-selected={status === f.v}
            onClick={() => setStatus(f.v)}
            className={`min-h-11 min-w-0 rounded-full px-1 text-[15px] font-bold whitespace-nowrap ${status === f.v ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
            data-testid={`filter-${f.v}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && warn > 0 && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-base font-bold text-red-800" role="status" data-testid="alert-summary">
          ⛔ {warn} 家門店有異常警示
        </p>
      )}
      {data && data.stores.length === 0 && (
        <Empty
          title={term ? "找不到符合的門店" : status === "all" ? "還沒有門店" : "沒有這個狀態的門店"}
          text={term ? `沒有名稱或門店碼包含「${term}」的門店。` : status === "all" ? "按下方「建立門店」新增第一家。" : undefined}
        />
      )}
      {data && data.stores.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="store-list">
          {data.stores.map((s) => (
            <li key={s.id}>
              <button
                className="flex w-full flex-col gap-2 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
                onClick={() => navigate(`/stores/${encodeURIComponent(s.id)}`)}
                data-testid={`store-${s.code}`}
              >
                <div className="flex w-full items-start gap-2">
                  <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${s.status === "active" ? "bg-emerald-500" : s.status === "expired" ? "bg-amber-500" : "bg-slate-400"}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-bold text-slate-900">{s.name}</span>
                    <span className="block text-sm text-slate-500">
                      {s.code}
                      {s.features?.internal ? " · 內部測試" : ""}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[s.status]}</Badge>
                </div>
                <div className="grid w-full grid-cols-3 gap-2 text-sm">
                  <Stat label="到期" value={s.expiresAt ? date(s.expiresAt) : "不到期"} />
                  <Stat label="面板" value={`${s.displays ?? 0} / ${s.maxDevices}`} danger={(s.displays ?? 0) >= s.maxDevices && s.maxDevices > 0} />
                  <Stat label={s.monthAllocatedUsd != null ? "本月分攤" : "本月估算"} value={usd(s.monthAllocatedUsd ?? s.monthEstUsd ?? 0)} />
                </div>
                {!!s.alerts?.length && (
                  <div className="w-full">
                    <AlertList alerts={s.alerts} compact />
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col rounded-lg bg-slate-50 px-2 py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`truncate font-bold tabular-nums ${danger ? "text-red-700" : "text-slate-800"}`}>{value}</span>
    </span>
  );
}

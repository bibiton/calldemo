import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { dateTime, monthLabel, shiftMonth, usd } from "../lib/format";
import { LINE_TEXT } from "../lib/types";
import { thisMonth } from "./Usage";
import { Button, Card, ErrorBox, inputCls, Loading, Page, errText, revealError, toast, useLoad } from "../ui";

interface Resp {
  month: string;
  items: Record<string, number>;
  lineItems: string[];
  enteredAt: number | null;
  enteredBy: string | null;
}

const AMOUNT = /^\d{0,7}(\.\d{0,2})?$/;

export function Billing() {
  const { query } = useRoute();
  const month = /^\d{4}-\d{2}$/.test(query.get("month") ?? "") ? query.get("month")! : thisMonth();
  const { data, error, reload } = useLoad(() => api<Resp>(`/api/admin/billing?month=${month}`), [month]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (data) setVals(Object.fromEntries(data.lineItems.map((k) => [k, data.items[k] != null ? String(data.items[k]) : ""])));
  }, [data]);
  const bad = Object.entries(vals).filter(([, v]) => v !== "" && (!AMOUNT.test(v) || Number.isNaN(Number(v))));
  const total = Object.values(vals).reduce((a, v) => a + (Number(v) || 0), 0);

  async function save() {
    setTouched(true);
    if (bad.length) return revealError();
    setBusy(true);
    try {
      // 只送有變動的項目（留空且原本沒有的不送，稽核紀錄才不會一堆「清除」）
      const orig = data?.items ?? {};
      const items = Object.fromEntries(
        Object.entries(vals)
          .map(([k, v]) => [k, v === "" ? null : Number(v)] as const)
          .filter(([k, v]) => (v === null ? orig[k] != null : orig[k] !== v)),
      );
      if (!Object.keys(items).length) {
        toast("沒有變更");
        setBusy(false);
        return;
      }
      await api("/api/admin/billing", { method: "PUT", json: { month, items } });
      toast("已儲存，分攤已重算");
      navigate(`/usage?month=${month}`);
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Page
      title="輸入帳單"
      back={`/usage?month=${month}`}
      testId="billing"
      footer={
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-base">
            合計 <b className="text-lg tabular-nums">{usd(total)}</b>
          </p>
          <Button onClick={save} disabled={busy || !data} data-testid="billing-save">
            {busy ? "儲存中…" : "儲存並分攤"}
          </Button>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-2">
        <button className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand ring-1 ring-slate-300" onClick={() => navigate(`/billing?month=${shiftMonth(month, -1)}`, true)} aria-label="上個月">
          ‹
        </button>
        <h2 className="text-lg font-bold">{monthLabel(month)}</h2>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand ring-1 ring-slate-300 disabled:opacity-30"
          onClick={() => navigate(`/billing?month=${shiftMonth(month, 1)}`, true)}
          disabled={month >= thisMonth()}
          aria-label="下個月"
        >
          ›
        </button>
      </div>
      <p className="text-base leading-relaxed text-slate-600">
        依 Cloudflare 帳單（Billing → Invoices）逐項填入美元金額，沒有的留空。系統依各店用量占比分攤；Workers 月費由當月活躍門店平均分攤。
      </p>
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <Card className="flex flex-col divide-y divide-slate-100 !p-0">
          {data.lineItems.map((k) => {
            const invalid = touched && bad.some(([b]) => b === k);
            return (
              <label key={k} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-bold">{LINE_TEXT[k]?.label ?? k}</span>
                  <span className={`block text-sm ${invalid ? "font-bold text-red-700" : "text-slate-500"}`} role={invalid ? "alert" : undefined}>
                    {invalid ? "請輸入金額（最多兩位小數）" : LINE_TEXT[k]?.basis}
                  </span>
                </span>
                <span className="relative w-32 shrink-0">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-slate-500">$</span>
                  <input
                    className={`${inputCls} pl-7 text-right tabular-nums`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={vals[k] ?? ""}
                    onChange={(e) => setVals({ ...vals, [k]: e.target.value.trim() })}
                    aria-invalid={invalid}
                    aria-label={`${LINE_TEXT[k]?.label ?? k}（USD）`}
                    data-testid={`bill-${k}`}
                  />
                </span>
              </label>
            );
          })}
        </Card>
      )}
      {data?.enteredAt && (
        <p className="text-sm text-slate-500">
          上次由 {data.enteredBy} 於 {dateTime(data.enteredAt)} 輸入
        </p>
      )}
    </Page>
  );
}

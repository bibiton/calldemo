import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { invalidateMe, useMe } from "../lib/me";
import { Button, Card, ErrorBox, inputCls, Loading, Page, Toggle, errText, revealError, toast } from "../ui";

type Range = { open: string; close: string };
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const NAME = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

export function Hours() {
  const me = useMe();
  const [allDay, setAllDay] = useState(true);
  const [week, setWeek] = useState<Record<number, Range[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const h = me.data?.store.businessHours;
    if (!h) return;
    setAllDay(h.length === 0);
    const w: Record<number, Range[]> = {};
    for (const x of h) (w[x.dow] ??= []).push({ open: x.open, close: x.close });
    setWeek(w);
  }, [me.data]);

  const bad = (r: Range) => !r.open || !r.close || r.open >= r.close;
  const anyBad = !allDay && Object.values(week).some((rs) => rs.some(bad));
  const none = !allDay && !Object.values(week).some((rs) => rs.length);

  async function save() {
    if (anyBad || none) {
      setErr(none ? "至少要有一天營業，或改選「全天開放取號」。" : "有時段的開始時間晚於結束時間，請修正紅色欄位。");
      revealError();
      return;
    }
    setBusy(true);
    setErr(null);
    const businessHours = allDay ? [] : DAYS.flatMap((d) => (week[d] ?? []).map((r) => ({ dow: d, ...r })));
    try {
      await api("/api/store/hours", { method: "PUT", json: { businessHours } });
      toast("營業時間已儲存");
      invalidateMe();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  }

  const setDay = (d: number, rs: Range[]) => setWeek((w) => ({ ...w, [d]: rs }));

  return (
    <Page
      title="營業時間"
      back="/more"
      testId="hours"
      footer={
        <Button className="w-full" onClick={() => void save()} disabled={busy || !me.data} data-testid="save">
          {busy ? "儲存中…" : "儲存營業時間"}
        </Button>
      }
    >
      {me.error && <ErrorBox text={me.error} onRetry={me.reload} />}
      {!me.data && !me.error && <Loading />}
      {me.data && (
        <>
          <Card>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold">全天開放取號</p>
                <p className="text-sm text-slate-500">關閉後依下方每週時段；營業時間外面板顯示「休息中」、暫停取號</p>
              </div>
              <Toggle checked={allDay} onChange={setAllDay} label="全天開放取號" testId="all-day" />
            </div>
            <p className="mt-2 text-sm text-slate-500">時區：{me.data.store.timezone}（由平台設定）</p>
          </Card>
          {!allDay &&
            DAYS.map((d) => {
              const rs = week[d] ?? [];
              return (
                <Card key={d} testId={`day-${d}`}>
                  <div className="flex items-center gap-3">
                    <p className="flex-1 text-lg font-bold">{NAME[d]}</p>
                    <span className={`text-sm font-bold ${rs.length ? "text-emerald-700" : "text-slate-500"}`}>{rs.length ? "營業" : "公休"}</span>
                    <Toggle checked={rs.length > 0} onChange={(on) => setDay(d, on ? [{ open: "11:00", close: "21:00" }] : [])} label={`${NAME[d]}營業`} testId={`day-toggle-${d}`} />
                  </div>
                  {rs.map((r, i) => (
                    <div key={i} className="mt-2 flex items-center gap-2">
                      <input
                        type="time"
                        className={`${inputCls} !w-auto min-w-0 flex-1 tabular-nums`}
                        value={r.open}
                        aria-label={`${NAME[d]}開始`}
                        aria-invalid={bad(r)}
                        onChange={(e) => setDay(d, rs.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                      />
                      <span className="text-slate-500">–</span>
                      <input
                        type="time"
                        className={`${inputCls} !w-auto min-w-0 flex-1 tabular-nums`}
                        value={r.close}
                        aria-label={`${NAME[d]}結束`}
                        aria-invalid={bad(r)}
                        onChange={(e) => setDay(d, rs.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}
                      />
                      {rs.length > 1 && (
                        <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-slate-500 active:bg-slate-100" aria-label="刪除時段" onClick={() => setDay(d, rs.filter((_, j) => j !== i))}>
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {rs.some(bad) && <p className="mt-1 text-sm font-bold text-red-700">結束時間要晚於開始時間</p>}
                  {rs.length > 0 && rs.length < 3 && (
                    <button className="mt-1 min-h-11 text-base text-brand underline" onClick={() => setDay(d, [...rs, { open: "17:00", close: "21:00" }])}>
                      ＋ 加一個時段（例如午休後）
                    </button>
                  )}
                </Card>
              );
            })}
          {err && (
            <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="form-error">
              {err}
            </p>
          )}
        </>
      )}
    </Page>
  );
}

import { useState } from "react";
import { api } from "../lib/api";
import { invalidateMe } from "../lib/me";
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, inputCls, Loading, Page, Sheet, Toggle, errText, toast, useLoad } from "../ui";

interface Ctr {
  id: string;
  name: string;
  number: number;
  serviceIds: string[];
  enabled: boolean;
}
interface Svc {
  id: string;
  name: string;
  prefix: string;
}
type Draft = { id?: string; name: string; number: string; serviceIds: string[]; enabled: boolean };

export function Counters() {
  const { data, error, reload } = useLoad(async () => {
    const [c, s] = await Promise.all([api<{ counters: Ctr[] }>("/api/store/counters"), api<{ services: Svc[] }>("/api/store/services")]);
    return { counters: c.counters, services: s.services };
  });
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<Ctr | null>(null);
  const [busy, setBusy] = useState(false);
  const next = data ? Math.max(0, ...data.counters.map((c) => c.number)) + 1 : 1;

  return (
    <Page
      title="櫃台"
      back="/more"
      testId="counters"
      footer={
        <Button className="w-full" onClick={() => setEdit({ name: `${next} 號櫃台`, number: String(next), serviceIds: [], enabled: true })} data-testid="add-counter">
          ＋ 新增櫃台
        </Button>
      }
    >
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.counters.length === 0 && <Empty title="還沒有櫃台" text="新增櫃台後，人員才能選擇櫃台叫號。" />}
      {data?.counters.map((c) => (
        <Card key={c.id} testId={`counter-${c.number}`}>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl font-black text-brand tabular-nums">{c.number}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold">{c.name}</p>
              <p className="text-sm text-slate-500">
                {c.serviceIds.length ? `服務：${c.serviceIds.map((id) => data.services.find((s) => s.id === id)?.prefix ?? "?").join("、")}` : "可叫所有服務類別"}
              </p>
            </div>
            {!c.enabled && <Badge>已停用</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button kind="secondary" onClick={() => setEdit({ id: c.id, name: c.name, number: String(c.number), serviceIds: c.serviceIds, enabled: c.enabled })}>
              編輯
            </Button>
            <Button kind="danger" onClick={() => setDel(c)}>
              刪除
            </Button>
          </div>
        </Card>
      ))}
      {edit && data && <CounterSheet d={edit} services={data.services} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); invalidateMe(); }} />}
      {del && (
        <Confirm
          title={`刪除「${del.name}」？`}
          text="刪除後人員無法再選這個櫃台叫號。"
          ok="刪除"
          danger
          busy={busy}
          onCancel={() => setDel(null)}
          onOk={async () => {
            setBusy(true);
            try {
              await api(`/api/store/counters/${del.id}`, { method: "DELETE" });
              toast("已刪除");
              setDel(null);
              reload();
              invalidateMe();
            } catch (e) {
              toast(errText(e), "err");
            }
            setBusy(false);
          }}
        />
      )}
    </Page>
  );
}

function CounterSheet({ d, services, onClose, onSaved }: { d: Draft; services: Svc[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(d);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameErr = !v.name.trim() ? "請輸入名稱" : [...v.name.trim()].length > 20 ? "最多 20 字" : null;
  const numErr = !/^\d{1,2}$/.test(v.number) || Number(v.number) < 1 ? "請輸入 1～99（語音會唸這個號碼）" : null;
  const toggleSvc = (id: string) => setV({ ...v, serviceIds: v.serviceIds.includes(id) ? v.serviceIds.filter((x) => x !== id) : [...v.serviceIds, id] });

  async function save() {
    setTouched(true);
    if (nameErr || numErr) return;
    setBusy(true);
    setErr(null);
    try {
      await api(v.id ? `/api/store/counters/${v.id}` : "/api/store/counters", {
        method: v.id ? "PUT" : "POST",
        json: { name: v.name.trim(), number: Number(v.number), serviceIds: v.serviceIds, enabled: v.enabled },
      });
      toast("已儲存");
      onSaved();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={v.id ? "編輯櫃台" : "新增櫃台"} onClose={onClose} testId="counter-sheet" footer={<Button className="w-full" onClick={() => void save()} disabled={busy} data-testid="save">{busy ? "儲存中…" : "儲存"}</Button>}>
      <Field label="名稱" error={touched ? nameErr : null}>
        <input className={inputCls} value={v.name} maxLength={20} onChange={(e) => setV({ ...v, name: e.target.value })} aria-invalid={touched && !!nameErr} data-testid="ctr-name" />
      </Field>
      <Field label="櫃台號碼" hint="叫號語音：「請到 N 號櫃台」" error={touched ? numErr : null}>
        <input className={inputCls} inputMode="numeric" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value.replace(/\D/g, "").slice(0, 2) })} aria-invalid={touched && !!numErr} data-testid="ctr-number" />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-base font-bold">可服務類別</legend>
        <p className="mb-1 text-sm text-slate-500">都不勾＝可叫所有類別</p>
        {services.map((s) => (
          <label key={s.id} className="flex min-h-12 items-center gap-3 rounded-xl px-2 active:bg-slate-50">
            <input type="checkbox" className="h-6 w-6 accent-brand" checked={v.serviceIds.includes(s.id)} onChange={() => toggleSvc(s.id)} />
            <span className="text-base">
              {s.prefix} {s.name}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-1">
        <span className="text-base font-bold">啟用</span>
        <Toggle checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="啟用" />
      </div>
      {err && <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="sheet-error">{err}</p>}
    </Sheet>
  );
}

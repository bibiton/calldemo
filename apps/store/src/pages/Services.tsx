import { useState } from "react";
import { api } from "../lib/api";
import { invalidateMe } from "../lib/me";
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, inputCls, Loading, Page, Sheet, Toggle, errText, toast, useLoad } from "../ui";

interface Svc {
  id: string;
  name: string;
  prefix: string;
  sortOrder: number;
  enabled: boolean;
  dailyLimit: number | null;
}
type Draft = { id?: string; name: string; prefix: string; sortOrder: string; dailyLimit: string; enabled: boolean };

export function Services() {
  const { data, error, reload } = useLoad(() => api<{ services: Svc[] }>("/api/store/services"));
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<Svc | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (s?: Svc) =>
    setEdit(
      s
        ? { id: s.id, name: s.name, prefix: s.prefix, sortOrder: String(s.sortOrder), dailyLimit: s.dailyLimit ? String(s.dailyLimit) : "", enabled: s.enabled }
        : { name: "", prefix: "", sortOrder: String((data?.services.length ?? 0) + 1), dailyLimit: "", enabled: true },
    );

  return (
    <Page
      title="服務類別"
      back="/more"
      testId="services"
      footer={
        <Button className="w-full" onClick={() => open()} data-testid="add-service">
          ＋ 新增服務類別
        </Button>
      }
    >
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.services.length === 0 && <Empty title="還沒有服務類別" text="新增後顧客才能選擇服務取號。" />}
      {data?.services.map((s) => (
        <Card key={s.id} testId={`service-${s.prefix}`}>
          <div className="flex items-center gap-3">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-black ${s.enabled ? "bg-brand text-white" : "bg-slate-200 text-slate-500"}`}>{s.prefix}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold">{s.name}</p>
              <p className="text-sm text-slate-500">
                排序 {s.sortOrder} · {s.dailyLimit ? `每日上限 ${s.dailyLimit} 號` : "不限號數"}
              </p>
            </div>
            {!s.enabled && <Badge>已停用</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button kind="secondary" onClick={() => open(s)} data-testid={`edit-service-${s.prefix}`}>
              編輯
            </Button>
            <Button kind="danger" onClick={() => setDel(s)}>
              刪除
            </Button>
          </div>
        </Card>
      ))}
      {edit && <ServiceSheet d={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); invalidateMe(); }} />}
      {del && (
        <Confirm
          title={`刪除「${del.name}」？`}
          text="刪除後顧客不能再選這個服務；已取的號碼不受影響。若只是暫時不開放，建議改用「停用」。"
          ok="刪除"
          danger
          busy={busy}
          onCancel={() => setDel(null)}
          onOk={async () => {
            setBusy(true);
            try {
              await api(`/api/store/services/${del.id}`, { method: "DELETE" });
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

function ServiceSheet({ d, onClose, onSaved }: { d: Draft; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(d);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameErr = !v.name.trim() ? "請輸入名稱" : [...v.name.trim()].length > 20 ? "最多 20 字" : null;
  const prefixErr = !/^[A-Z]{1,2}$/.test(v.prefix) ? "請輸入 1～2 個英文大寫字母" : null;
  const sortErr = !/^\d{1,3}$/.test(v.sortOrder) ? "請輸入 0～999" : null;
  const limitErr = v.dailyLimit && !/^\d{1,4}$/.test(v.dailyLimit) ? "請輸入 1～9999，或留空表示不限" : v.dailyLimit === "0" ? "請輸入 1～9999，或留空表示不限" : null;
  const bad = nameErr || prefixErr || sortErr || limitErr;

  async function save() {
    setTouched(true);
    if (bad) return;
    setBusy(true);
    setErr(null);
    const body = { name: v.name.trim(), prefix: v.prefix, sortOrder: Number(v.sortOrder), dailyLimit: v.dailyLimit ? Number(v.dailyLimit) : null, enabled: v.enabled };
    try {
      await api(v.id ? `/api/store/services/${v.id}` : "/api/store/services", { method: v.id ? "PUT" : "POST", json: body });
      toast("已儲存");
      onSaved();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={v.id ? "編輯服務類別" : "新增服務類別"}
      onClose={onClose}
      testId="service-sheet"
      footer={
        <Button className="w-full" onClick={() => void save()} disabled={busy} data-testid="save">
          {busy ? "儲存中…" : "儲存"}
        </Button>
      }
    >
      <Field label="名稱" error={touched ? nameErr : null}>
        <input className={inputCls} value={v.name} maxLength={20} onChange={(e) => setV({ ...v, name: e.target.value })} aria-invalid={touched && !!nameErr} data-testid="svc-name" placeholder="例如：內用" />
      </Field>
      <Field label="字首" hint="號碼開頭的英文字母，例如 A → A001。A～F 語音最自然。" error={touched ? prefixErr : null}>
        <input
          className={`${inputCls} uppercase`}
          value={v.prefix}
          maxLength={2}
          autoCapitalize="characters"
          onChange={(e) => setV({ ...v, prefix: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })}
          aria-invalid={touched && !!prefixErr}
          data-testid="svc-prefix"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="排序" error={touched ? sortErr : null}>
          <input className={inputCls} inputMode="numeric" value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: e.target.value.replace(/\D/g, "") })} aria-invalid={touched && !!sortErr} />
        </Field>
        <Field label="每日上限" hint="留空＝不限" error={touched ? limitErr : null}>
          <input className={inputCls} inputMode="numeric" value={v.dailyLimit} onChange={(e) => setV({ ...v, dailyLimit: e.target.value.replace(/\D/g, "") })} aria-invalid={touched && !!limitErr} data-testid="svc-limit" />
        </Field>
      </div>
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-1">
        <span className="text-base font-bold">開放取號</span>
        <Toggle checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="開放取號" testId="svc-enabled" />
      </div>
      {err && (
        <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="sheet-error">
          {err}
        </p>
      )}
    </Sheet>
  );
}

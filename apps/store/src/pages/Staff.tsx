import { useState } from "react";
import { api } from "../lib/api";
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, inputCls, Loading, Page, Sheet, errText, toast, useLoad } from "../ui";

interface StaffRow {
  id: string;
  displayName: string;
  status: "active" | "disabled";
  locked: boolean;
}

export function Staff() {
  const { data, error, reload } = useLoad(() => api<{ staff: StaffRow[]; maxStaff: number }>("/api/store/staff"));
  const [adding, setAdding] = useState(false);
  const [pin, setPin] = useState<{ name: string; pin: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "reset" | "disable"; u: StaffRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const active = data?.staff.filter((s) => s.status === "active").length ?? 0;
  const full = !!data && active >= data.maxStaff;

  async function act(kind: "reset" | "disable" | "enable", u: StaffRow) {
    setBusy(true);
    try {
      if (kind === "reset") {
        const r = await api<{ pin: string }>(`/api/store/staff/${u.id}/reset-pin`, { method: "POST" });
        setPin({ name: u.displayName, pin: r.pin });
      } else {
        await api(`/api/store/staff/${u.id}/${kind}`, { method: "POST" });
        toast(kind === "disable" ? "已停用" : "已啟用");
      }
      setConfirm(null);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Page
      title="人員帳號"
      back="/more"
      testId="staff"
      footer={
        <div className="flex flex-col gap-1">
          <Button className="w-full" onClick={() => setAdding(true)} disabled={full} data-testid="add-staff">
            ＋ 新增人員
          </Button>
          {data && (
            <p className={`text-center text-sm ${full ? "font-bold text-red-700" : "text-slate-500"}`} data-testid="staff-count">
              {full ? `已達上限 ${data.maxStaff} 人，請先停用不用的帳號` : `使用中 ${active} / ${data.maxStaff} 人`}
            </p>
          )}
        </div>
      }
    >
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.staff.length === 0 && <Empty title="還沒有人員" text="新增後會產生 6 位 PIN，人員在綁定的手機上選名字＋輸入 PIN 登入。" />}
      {data?.staff.map((u) => (
        <Card key={u.id} testId={`staff-row`}>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-lg font-bold">{u.displayName}</p>
            {u.status === "disabled" ? <Badge>已停用</Badge> : u.locked ? <Badge tone="red">PIN 鎖定中</Badge> : <Badge tone="green">使用中</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button kind="secondary" disabled={u.status !== "active"} onClick={() => setConfirm({ kind: "reset", u })}>
              重設 PIN
            </Button>
            {u.status === "active" ? (
              <Button kind="danger" onClick={() => setConfirm({ kind: "disable", u })}>
                停用
              </Button>
            ) : (
              <Button kind="secondary" onClick={() => void act("enable", u)} disabled={busy}>
                重新啟用
              </Button>
            )}
          </div>
        </Card>
      ))}
      {adding && <AddSheet onClose={() => setAdding(false)} onAdded={(n, p) => { setAdding(false); setPin({ name: n, pin: p }); reload(); }} />}
      {confirm && (
        <Confirm
          title={confirm.kind === "reset" ? `重設「${confirm.u.displayName}」的 PIN？` : `停用「${confirm.u.displayName}」？`}
          text={confirm.kind === "reset" ? "舊 PIN 立即失效，正在使用的人員端會被登出。" : "停用後無法登入，正在使用的人員端會立即被登出。"}
          ok={confirm.kind === "reset" ? "重設" : "停用"}
          danger={confirm.kind === "disable"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onOk={() => void act(confirm.kind, confirm.u)}
        />
      )}
      {pin && (
        <Sheet title="請記下 PIN" onClose={() => setPin(null)} testId="pin-sheet" footer={<Button className="w-full" onClick={() => setPin(null)}>我已記下</Button>}>
          <p className="text-base text-slate-700">「{pin.name}」的登入 PIN：</p>
          <p className="text-center text-5xl font-black tracking-[0.25em] text-brand tabular-nums" data-testid="new-pin">
            {pin.pin}
          </p>
          <p className="rounded-xl bg-amber-50 p-3 text-base text-amber-900">PIN 只顯示這一次，關閉後就看不到了。忘記時請重設。</p>
        </Sheet>
      )}
    </Page>
  );
}

function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string, pin: string) => void }) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameErr = !name.trim() ? "請輸入名字" : [...name.trim()].length > 20 ? "最多 20 字" : null;
  async function save() {
    setTouched(true);
    if (nameErr) return;
    setBusy(true);
    try {
      const r = await api<{ pin: string }>("/api/store/staff", { method: "POST", json: { displayName: name.trim() } });
      onAdded(name.trim(), r.pin);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }
  return (
    <Sheet title="新增人員" onClose={onClose} testId="staff-sheet" footer={<Button className="w-full" onClick={() => void save()} disabled={busy} data-testid="save">{busy ? "建立中…" : "建立並產生 PIN"}</Button>}>
      <Field label="顯示名稱" hint="人員登入時在手機上點選的名字" error={touched ? nameErr : null}>
        <input className={inputCls} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!nameErr} data-testid="staff-name" placeholder="例如：林店員" />
      </Field>
      {err && <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="sheet-error">{err}</p>}
    </Sheet>
  );
}

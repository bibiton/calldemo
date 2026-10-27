import { useState } from "react";
import { api } from "../lib/api";
import { useRoute } from "../lib/router";
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, inputCls, Loading, Page, errText, toast, useLoad } from "../ui";

interface Dev {
  id: string;
  kind: "display" | "staff_device";
  name: string;
  client: string | null;
  audio: "ok" | "blocked" | null;
  createdAt: number;
}

const CLIENT: Record<string, string> = { android_app: "Android 叫號 App", fully: "Fully Kiosk", chrome_kiosk: "Chrome kiosk", browser: "一般瀏覽器" };

export function Devices() {
  const { query } = useRoute();
  const { data, error, reload } = useLoad(() => api<{ devices: Dev[]; maxDevices: number }>("/api/store/devices"));
  const [code, setCode] = useState(query.get("code")?.replace(/\D/g, "").slice(0, 6) ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [del, setDel] = useState<Dev | null>(null);
  const displays = data?.devices.filter((d) => d.kind === "display") ?? [];
  const phones = data?.devices.filter((d) => d.kind === "staff_device") ?? [];
  const codeErr = !/^\d{6}$/.test(code) ? "請輸入裝置畫面上的 6 位數配對碼" : null;

  async function pair() {
    setTouched(true);
    if (codeErr) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ device: Dev }>("/api/store/devices/pair", { method: "POST", json: { code, name: name.trim() || undefined } });
      toast(`已配對：${r.device.name}`);
      setCode("");
      setName("");
      setTouched(false);
      reload();
    } catch (e: any) {
      setErr(e?.code === "DEVICE_LIMIT" ? `叫號面板已達上限（${e.body?.max ?? data?.maxDevices} 台），請先移除不用的面板。` : errText(e));
    }
    setBusy(false);
  }

  const row = (d: Dev) => (
    <li key={d.id} className="flex min-h-16 items-center gap-3 px-4 py-3" data-testid="device-row">
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold">{d.name}</p>
        <p className="text-sm text-slate-500">
          {d.kind === "display" ? (d.client ? CLIENT[d.client] ?? d.client : "尚未連線") : "人員手機"} · {new Date(d.createdAt).toLocaleDateString("zh-TW")} 配對
        </p>
        {d.kind === "display" && d.audio === "blocked" && (
          <p className="mt-1">
            <Badge tone="red">🔇 無法出聲</Badge>
          </p>
        )}
      </div>
      <Button kind="danger" className="!min-h-11 shrink-0" onClick={() => setDel(d)}>
        移除
      </Button>
    </li>
  );

  return (
    <Page title="裝置" back="/more" testId="devices">
      <Card>
        <h2 className="text-lg font-bold">配對新裝置</h2>
        <p className="mt-1 text-base text-slate-600">叫號面板或人員手機開啟後會顯示 6 位數配對碼，輸入後即完成配對（面板只需遙控器，不用打字）。</p>
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
          noValidate
        >
          <Field label="配對碼" error={touched ? codeErr : null}>
            <input
              className={`${inputCls} text-center text-2xl font-bold tracking-[0.3em] tabular-nums`}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-invalid={touched && !!codeErr}
              placeholder="000000"
              data-testid="pair-code"
            />
          </Field>
          <Field label="裝置名稱（選填）" hint="例如：門口面板、2 號櫃台手機">
            <input className={inputCls} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} data-testid="pair-name" />
          </Field>
          {err && (
            <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="pair-error">
              {err}
            </p>
          )}
          <Button type="submit" disabled={busy} data-testid="pair-submit">
            {busy ? "配對中…" : "配對"}
          </Button>
        </form>
      </Card>

      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-bold text-slate-600">叫號面板</h2>
            <span className={`text-sm font-bold tabular-nums ${displays.length >= data.maxDevices ? "text-red-700" : "text-slate-500"}`} data-testid="display-count">
              {displays.length} / {data.maxDevices} 台
            </span>
          </div>
          {displays.length ? <Card className="!p-0"><ul className="divide-y divide-slate-100">{displays.map(row)}</ul></Card> : <Empty title="還沒有叫號面板" />}
          <h2 className="text-base font-bold text-slate-600">人員手機</h2>
          {phones.length ? <Card className="!p-0"><ul className="divide-y divide-slate-100">{phones.map(row)}</ul></Card> : <Empty title="還沒有人員手機" />}
        </>
      )}
      {del && (
        <Confirm
          title={`移除「${del.name}」？`}
          text={del.kind === "display" ? "面板會立即斷線並回到配對畫面。" : "這支手機會立即被登出，無法再登入人員端。"}
          ok="移除"
          danger
          busy={busy}
          onCancel={() => setDel(null)}
          onOk={async () => {
            setBusy(true);
            try {
              await api(`/api/store/devices/${del.id}/revoke`, { method: "POST" });
              toast("已移除");
              setDel(null);
              reload();
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

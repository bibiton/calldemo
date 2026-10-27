import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { bytes, date, endOfDay, mbOf, ymd } from "../lib/format";
import { STATUS_TEXT, STATUS_TONE, type Alert, type StoreSummary } from "../lib/types";
import { AlertList } from "../components/Alerts";
import { PasswordOnce } from "../components/PasswordOnce";
import { TIMEZONES } from "./StoreNew";
import { Badge, Button, Card, Confirm, ErrorBox, Field, inputCls, Loading, Page, Sheet, Toggle, errText, revealError, toast, useLoad } from "../ui";

interface Detail {
  store: StoreSummary & { deletedAt: number | null };
  admins: { id: string; email: string; displayName: string; status: "active" | "disabled"; locked: boolean; createdAt: number }[];
  devices: { id: string; kind: "display" | "staff_device"; name: string; client: string | null; audio: string | null; audioAt: number | null }[];
  counts: { staff: number; services: number; counters: number };
  adBytes: number;
  live: { deviceId: string | null; audio: string | null; client: string | null }[] | null;
  alerts: Alert[];
}

const FEATURES: [string, string, string][] = [
  ["push", "背景推播", "顧客離開頁面也收得到叫號通知"],
  ["ads", "面板廣告", "叫號面板輪播廣告"],
  ["voice", "叫號語音", "面板唸出號碼"],
  ["showMaskedName", "面板顯示遮罩姓名", "例：王○明"],
  ["internal", "內部測試門店", "用量另列「平台」，不分攤 Workers 月費"],
  ["demo", "DEMO 門店", "面板與顧客頁顯示 DEMO・虛構品牌 浮水印"],
  ["demoSimulate", "模擬叫號", "DEMO 門店才有效；營業時間內且有面板連線時自動取號叫號"],
];
const CLIENT: Record<string, string> = { android_app: "Android 叫號 App", fully: "Fully Kiosk", chrome_kiosk: "Chrome kiosk", browser: "一般瀏覽器" };

export function StoreDetail({ id }: { id: string }) {
  const { data, error, reload, setData } = useLoad(() => api<Detail>(`/api/admin/stores/${encodeURIComponent(id)}`), [id]);
  const [confirm, setConfirm] = useState<null | "suspend" | "resume">(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [newAdmin, setNewAdmin] = useState(false);
  const [pw, setPw] = useState<{ email: string; password: string } | null>(null);
  const [adminAct, setAdminAct] = useState<{ id: string; email: string; act: "reset" | "disable" | "enable" } | null>(null);

  if (error) return <Page title="門店" back="/"><ErrorBox text={error} onRetry={reload} /></Page>;
  if (!data) return <Page title="門店" back="/"><Loading /></Page>;
  const s = data.store;
  const deleted = s.status === "deleted";

  async function setStatus(to: "suspend" | "resume") {
    setBusy(true);
    try {
      await api(`/api/admin/stores/${encodeURIComponent(id)}/${to}`, { method: "POST" });
      toast(to === "suspend" ? "已停用，面板與取號立即暫停" : "已恢復營業");
      setConfirm(null);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  async function adminAction() {
    if (!adminAct) return;
    setBusy(true);
    try {
      const path = adminAct.act === "reset" ? "reset-password" : adminAct.act;
      const r = await api<any>(`/api/admin/stores/${encodeURIComponent(id)}/admins/${adminAct.id}/${path}`, { method: "POST" });
      if (adminAct.act === "reset") setPw({ email: adminAct.email, password: r.password });
      else toast(adminAct.act === "disable" ? "已停用帳號" : "已啟用帳號");
      setAdminAct(null);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  const displays = data.devices.filter((d) => d.kind === "display");
  const phones = data.devices.filter((d) => d.kind === "staff_device");
  const liveMap = new Map((data.live ?? []).map((l) => [l.deviceId, l]));

  return (
    <Page title={s.name} back="/" testId="store-detail">
      <Card className="flex flex-col gap-3" testId="status-card">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap gap-x-3 text-sm text-slate-500">
              <span className="whitespace-nowrap">
                門店碼 <b className="text-slate-800">{s.code}</b>
              </span>
              <span className="whitespace-nowrap">{s.brandName ?? "預設品牌"}</span>
              <span className="whitespace-nowrap">到期 {s.expiresAt ? date(s.expiresAt) : "不到期"}</span>
              <span className="whitespace-nowrap">建立 {date(s.createdAt)}</span>
            </p>
          </div>
          <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[s.status]}</Badge>
        </div>
        {s.status === "expired" && <p className="text-base text-amber-900">已超過到期日：面板與取號已暫停。延長到期日即可恢復。</p>}
        {!deleted &&
          (s.status === "suspended" ? (
            <Button onClick={() => setConfirm("resume")} data-testid="resume">
              恢復營業
            </Button>
          ) : (
            <Button kind="danger" onClick={() => setConfirm("suspend")} data-testid="suspend">
              停用門店
            </Button>
          ))}
        <div className="grid grid-cols-2 gap-2">
          <Button kind="secondary" onClick={() => navigate(`/usage/stores/${encodeURIComponent(id)}`)}>
            用量與成本
          </Button>
          <Button kind="secondary" onClick={() => navigate(`/audit?storeId=${encodeURIComponent(id)}&name=${encodeURIComponent(s.name)}`)}>
            稽核紀錄
          </Button>
        </div>
      </Card>

      <AlertList alerts={data.alerts} />

      <Card testId="panels">
        <h2 className="mb-2 text-lg font-bold">叫號面板 {displays.length} / {s.maxDevices}</h2>
        {data.live === null && <p className="mb-2 text-sm text-amber-900">暫時無法取得即時連線狀態，以下為最後回報。</p>}
        {displays.length === 0 ? (
          <p className="text-base text-slate-500">尚未配對任何面板（由店長在門店後台配對）。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {displays.map((d) => {
              const l = liveMap.get(d.id);
              const online = !!l;
              const audio = l?.audio ?? (online ? null : d.audio);
              return (
                <li key={d.id} className="flex items-center gap-3 py-3" data-testid="panel-row">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-bold">{d.name}</p>
                    <p className="text-sm text-slate-500">
                      {online ? "在線" : "離線"}
                      {(l?.client ?? d.client) ? ` · ${CLIENT[(l?.client ?? d.client)!] ?? l?.client ?? d.client}` : ""}
                    </p>
                  </div>
                  {online && audio === "blocked" && <Badge tone="red">🔇 無法出聲</Badge>}
                  {online && audio === "ok" && <Badge tone="green">🔊 正常</Badge>}
                </li>
              );
            })}
          </ul>
        )}
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          {[
            ["人員手機", `${phones.length} 台`],
            ["人員", `${data.counts.staff} / ${s.maxStaff} 位`],
            ["服務類別", `${data.counts.services} 個`],
            ["櫃台", `${data.counts.counters} 個`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="font-bold text-slate-800 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {!deleted && <LimitsForm key={JSON.stringify(s)} store={s} adBytes={data.adBytes} onSaved={(st) => setData({ ...data, store: { ...data.store, ...st } })} reload={reload} />}

      <Card testId="admins">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">店長帳號</h2>
          {!deleted && (
            <Button kind="secondary" className="min-h-11 px-3" onClick={() => setNewAdmin(true)} data-testid="add-admin">
              ＋ 新增
            </Button>
          )}
        </div>
        {pw && (
          <div className="mb-3">
            <PasswordOnce email={pw.email} password={pw.password} />
          </div>
        )}
        <ul className="flex flex-col divide-y divide-slate-100">
          {data.admins.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-3" data-testid="admin-row">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold">{a.displayName}</p>
                  <p className="truncate text-sm text-slate-500">{a.email}</p>
                </div>
                {a.status === "disabled" ? <Badge>已停用</Badge> : a.locked ? <Badge tone="amber">登入鎖定中</Badge> : <Badge tone="green">啟用</Badge>}
              </div>
              {!deleted && (
                <div className="grid grid-cols-2 gap-2">
                  <Button kind="secondary" onClick={() => setAdminAct({ id: a.id, email: a.email, act: "reset" })}>
                    重設密碼
                  </Button>
                  {a.status === "active" ? (
                    <Button kind="danger" onClick={() => setAdminAct({ id: a.id, email: a.email, act: "disable" })}>
                      停用
                    </Button>
                  ) : (
                    <Button kind="secondary" onClick={() => setAdminAct({ id: a.id, email: a.email, act: "enable" })}>
                      啟用
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {!deleted && (
        <Card className="ring-red-200" testId="danger-zone">
          <h2 className="text-lg font-bold text-red-800">刪除門店</h2>
          <p className="mt-1 text-base text-slate-600">停用並封存：店長、人員與裝置全部失效；用量、報表與稽核紀錄保留。無法復原。</p>
          <Button kind="danger" className="mt-3 w-full" onClick={() => setDel(true)} data-testid="delete-store">
            刪除這家門店
          </Button>
        </Card>
      )}

      {confirm && (
        <Confirm
          title={confirm === "suspend" ? "停用門店？" : "恢復營業？"}
          text={confirm === "suspend" ? "停用後面板立即顯示「服務暫停」、顧客無法取號、人員與店長無法操作。可隨時恢復。" : "恢復後面板會自動重新連線，顧客可以再次取號。"}
          ok={confirm === "suspend" ? "停用" : "恢復"}
          danger={confirm === "suspend"}
          busy={busy}
          onOk={() => setStatus(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {adminAct && (
        <Confirm
          title={adminAct.act === "reset" ? "重設密碼？" : adminAct.act === "disable" ? "停用帳號？" : "啟用帳號？"}
          text={
            adminAct.act === "reset"
              ? `${adminAct.email} 的舊密碼立即失效，並登出所有裝置。新密碼只顯示一次。`
              : adminAct.act === "disable"
                ? `${adminAct.email} 將立即被登出且無法登入。`
                : `${adminAct.email} 可以再次登入。`
          }
          ok={adminAct.act === "reset" ? "重設" : adminAct.act === "disable" ? "停用" : "啟用"}
          danger={adminAct.act !== "enable"}
          busy={busy}
          onOk={adminAction}
          onCancel={() => setAdminAct(null)}
        />
      )}
      {newAdmin && (
        <NewAdmin
          storeId={id}
          onClose={() => setNewAdmin(false)}
          onDone={(email, password) => {
            setNewAdmin(false);
            setPw({ email, password });
            reload();
          }}
        />
      )}
      {del && <DeleteStore store={s} onClose={() => setDel(false)} />}
    </Page>
  );
}

function LimitsForm({ store, adBytes, onSaved, reload }: { store: StoreSummary; adBytes: number; onSaved: (s: Partial<StoreSummary>) => void; reload: () => void }) {
  const brands = useLoad(() => api<{ brands: { id: string; name: string }[] }>("/api/admin/brands"));
  const init = {
    name: store.name,
    timezone: store.timezone,
    brandId: store.brandId,
    expires: store.expiresAt ? ymd(store.expiresAt) : "",
    maxDevices: String(store.maxDevices),
    maxStaff: String(store.maxStaff),
    adMb: String(mbOf(store.adQuotaBytes)),
    features: { push: true, ads: true, voice: true, showMaskedName: false, internal: false, demo: false, demoSimulate: false, ...store.features } as Record<string, boolean>,
  };
  const [f, setF] = useState(init);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(init), [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const v = {
    name: !f.name.trim() ? "請輸入門店名稱" : null,
    maxDevices: !/^\d+$/.test(f.maxDevices) || +f.maxDevices > 50 ? "請輸入 0～50" : null,
    maxStaff: !/^\d+$/.test(f.maxStaff) || +f.maxStaff < 1 || +f.maxStaff > 200 ? "請輸入 1～200" : null,
    adMb: !/^\d+$/.test(f.adMb) || +f.adMb > 10240 ? "請輸入 0～10240 MB" : null,
  };
  const show = (k: keyof typeof v) => (touched ? v[k] : null);
  const quota = +f.adMb * 1048576;
  const ratio = quota > 0 ? adBytes / quota : adBytes > 0 ? 1 : 0;
  const plus = (days: number) => {
    const base = Math.max(Date.now(), f.expires ? endOfDay(f.expires) : Date.now());
    setF({ ...f, expires: ymd(base + days * 86400_000) });
  };

  async function save() {
    setTouched(true);
    if (Object.values(v).some(Boolean)) return revealError();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (f.name.trim() !== init.name) body.name = f.name.trim();
      if (f.timezone !== init.timezone) body.timezone = f.timezone;
      if (f.brandId !== init.brandId) body.brandId = f.brandId;
      if (f.expires !== init.expires) body.expiresAt = f.expires ? endOfDay(f.expires) : null;
      if (f.maxDevices !== init.maxDevices) body.maxDevices = +f.maxDevices;
      if (f.maxStaff !== init.maxStaff) body.maxStaff = +f.maxStaff;
      if (f.adMb !== init.adMb) body.adQuotaBytes = +f.adMb * 1048576;
      if (JSON.stringify(f.features) !== JSON.stringify(init.features)) body.features = f.features;
      const r = await api<{ store: StoreSummary }>(`/api/admin/stores/${encodeURIComponent(store.id)}`, { method: "PUT", json: body });
      onSaved(r.store);
      toast("已儲存，門店即時套用");
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Card className="flex flex-col gap-4" testId="limits">
      <h2 className="text-lg font-bold">授權與上限</h2>
      <Field label="到期日" hint={f.expires ? undefined : "目前不到期"}>
        <input className={inputCls} type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} data-testid="expires" />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Button kind="secondary" className="px-2" onClick={() => plus(30)}>
          ＋30 天
        </Button>
        <Button kind="secondary" className="px-2" onClick={() => plus(365)}>
          ＋1 年
        </Button>
        <Button kind="secondary" className="px-2" onClick={() => setF({ ...f, expires: "" })} disabled={!f.expires}>
          不到期
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="面板上限" error={show("maxDevices")}>
          <input className={inputCls} inputMode="numeric" value={f.maxDevices} onChange={(e) => setF({ ...f, maxDevices: e.target.value })} aria-invalid={!!show("maxDevices")} data-testid="max-devices" />
        </Field>
        <Field label="人員上限" error={show("maxStaff")}>
          <input className={inputCls} inputMode="numeric" value={f.maxStaff} onChange={(e) => setF({ ...f, maxStaff: e.target.value })} aria-invalid={!!show("maxStaff")} data-testid="max-staff" />
        </Field>
      </div>
      <Field label="廣告容量（MB）" error={show("adMb")}>
        <input className={inputCls} inputMode="numeric" value={f.adMb} onChange={(e) => setF({ ...f, adMb: e.target.value })} aria-invalid={!!show("adMb")} data-testid="ad-mb" />
      </Field>
      <div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-200" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label="廣告容量使用率">
          <div className={`h-full ${ratio >= 1 ? "bg-red-600" : ratio >= 0.9 ? "bg-amber-500" : "bg-emerald-600"}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        <p className="mt-1 text-sm text-slate-600 tabular-nums">
          已用 {bytes(adBytes)} / {bytes(quota)}（{Math.round(ratio * 100)}%）
        </p>
      </div>
      <fieldset className="flex flex-col divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
        <legend className="mb-2 text-base font-bold">功能開關</legend>
        {FEATURES.map(([k, label, hint]) => (
          <div key={k} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold">{label}</p>
              <p className="text-sm text-slate-500">{hint}</p>
            </div>
            <Toggle checked={!!f.features[k]} onChange={(on) => setF({ ...f, features: { ...f.features, [k]: on } })} label={label} testId={`feature-${k}`} />
          </div>
        ))}
      </fieldset>
      <Field label="門店名稱" error={show("name")}>
        <input className={inputCls} value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!show("name")} data-testid="name" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="時區">
          <select className={inputCls} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {[...TIMEZONES.map(([v]) => v), ...(TIMEZONES.some(([v]) => v === f.timezone) ? [] : [f.timezone])].map((v) => (
              <option key={v} value={v}>
                {TIMEZONES.find(([x]) => x === v)?.[1] ?? v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="品牌">
          <select className={inputCls} value={f.brandId} onChange={(e) => setF({ ...f, brandId: e.target.value })}>
            {(brands.data?.brands ?? [{ id: store.brandId, name: store.brandName ?? "預設品牌" }]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button kind="secondary" onClick={() => setF(init)} disabled={!dirty || busy}>
          還原
        </Button>
        <Button onClick={save} disabled={!dirty || busy} data-testid="save-limits">
          {busy ? "儲存中…" : "儲存"}
        </Button>
      </div>
    </Card>
  );
}

function NewAdmin({ storeId, onClose, onDone }: { storeId: string; onClose: () => void; onDone: (email: string, password: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("店長");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const eErr = !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? "請輸入正確的 Email" : err;
  async function submit() {
    setTouched(true);
    if (eErr || !name.trim()) return;
    setBusy(true);
    try {
      const r = await api<any>(`/api/admin/stores/${encodeURIComponent(storeId)}/admins`, { method: "POST", json: { email: email.trim(), displayName: name.trim() } });
      onDone(r.admin.email, r.admin.initialPassword);
    } catch (e: any) {
      setErr(errText(e));
    }
    setBusy(false);
  }
  return (
    <Sheet
      title="新增店長帳號"
      onClose={onClose}
      testId="new-admin"
      footer={
        <Button className="w-full" onClick={submit} disabled={busy} data-testid="new-admin-submit">
          {busy ? "建立中…" : "建立帳號"}
        </Button>
      }
    >
      <Field label="Email（登入帳號）" error={touched ? eErr : null}>
        <input className={inputCls} type="email" inputMode="email" value={email} onChange={(e) => (setEmail(e.target.value), setErr(null))} aria-invalid={touched && !!eErr} data-testid="new-admin-email" />
      </Field>
      <Field label="名稱" error={touched && !name.trim() ? "請輸入名稱" : null}>
        <input className={inputCls} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Sheet>
  );
}

function DeleteStore({ store, onClose }: { store: StoreSummary; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = code.trim().toUpperCase() === store.code;
  async function go() {
    setBusy(true);
    try {
      await api(`/api/admin/stores/${encodeURIComponent(store.id)}`, { method: "DELETE", json: { confirmCode: code.trim() } });
      toast(`已刪除 ${store.name}`);
      navigate("/", true);
    } catch (e) {
      toast(errText(e), "err");
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="刪除門店"
      onClose={onClose}
      testId="delete-sheet"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button kind="secondary" onClick={onClose}>
            取消
          </Button>
          <Button kind="danger" className="!bg-red-600 !text-white !ring-0 disabled:!bg-slate-200 disabled:!text-slate-500" disabled={!ok || busy} onClick={go} data-testid="delete-confirm">
            {busy ? "刪除中…" : "刪除"}
          </Button>
        </div>
      }
    >
      <p className="text-base leading-relaxed text-slate-700">
        「{store.name}」的店長、人員與面板會全部失效，顧客無法再取號。用量、報表與稽核紀錄會保留。
      </p>
      <Field label={`請輸入門店碼 ${store.code} 確認`}>
        <input className={`${inputCls} uppercase`} value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" data-testid="delete-code" />
      </Field>
    </Sheet>
  );
}

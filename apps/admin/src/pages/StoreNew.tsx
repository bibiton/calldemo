import { useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { endOfDay, ymd } from "../lib/format";
import { Button, Card, Field, inputCls, Page, revealError, errText, useLoad } from "../ui";
import { PasswordOnce } from "../components/PasswordOnce";

export const TIMEZONES = [
  ["Asia/Taipei", "台北（UTC+8）"],
  ["Asia/Hong_Kong", "香港（UTC+8）"],
  ["Asia/Shanghai", "上海（UTC+8）"],
  ["Asia/Singapore", "新加坡（UTC+8）"],
  ["Asia/Tokyo", "東京（UTC+9）"],
  ["Asia/Bangkok", "曼谷（UTC+7）"],
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function StoreNew() {
  const brands = useLoad(() => api<{ brands: { id: string; name: string }[] }>("/api/admin/brands"));
  const [f, setF] = useState({ name: "", code: "", timezone: "Asia/Taipei", brandId: "brand_default", expires: "", maxDevices: "2", maxStaff: "10", adMb: "500", email: "", adminName: "店長" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [done, setDone] = useState<{ id: string; name: string; email: string; password: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setF({ ...f, [k]: e.target.value });
    if (err?.field === k) setErr(null);
  };

  const v = {
    name: !f.name.trim() ? "請輸入門店名稱" : null,
    code: f.code && !/^[A-Za-z0-9]{4,8}$/.test(f.code) ? "門店碼為 4～8 個英數字（留空自動產生）" : err?.field === "code" ? err.text : null,
    maxDevices: !/^\d+$/.test(f.maxDevices) || +f.maxDevices > 50 ? "請輸入 0～50" : null,
    maxStaff: !/^\d+$/.test(f.maxStaff) || +f.maxStaff < 1 || +f.maxStaff > 200 ? "請輸入 1～200" : null,
    adMb: !/^\d+$/.test(f.adMb) || +f.adMb > 10240 ? "請輸入 0～10240 MB" : null,
    email: !EMAIL.test(f.email.trim()) ? "請輸入正確的 Email" : err?.field === "email" ? err.text : null,
    adminName: !f.adminName.trim() ? "請輸入店長名稱" : null,
  };
  const show = (k: keyof typeof v) => (touched || (k === "code" && err?.field === "code") || (k === "email" && err?.field === "email") ? v[k] : null);

  async function submit() {
    setTouched(true);
    setErr(null);
    const local = { ...v, code: f.code && !/^[A-Za-z0-9]{4,8}$/.test(f.code) ? v.code : null, email: !EMAIL.test(f.email.trim()) ? v.email : null };
    if (Object.values(local).some(Boolean)) return revealError();
    setBusy(true);
    try {
      const r = await api<any>("/api/admin/stores", {
        method: "POST",
        json: {
          name: f.name.trim(),
          code: f.code.trim().toUpperCase() || undefined,
          timezone: f.timezone,
          brandId: f.brandId,
          expiresAt: f.expires ? endOfDay(f.expires) : null,
          maxDevices: +f.maxDevices,
          maxStaff: +f.maxStaff,
          adQuotaBytes: +f.adMb * 1048576,
          admin: { email: f.email.trim(), displayName: f.adminName.trim() },
        },
      });
      setDone({ id: r.store.id, name: r.store.name, email: r.admin.email, password: r.admin.initialPassword });
    } catch (e: any) {
      if (e?.code === "CODE_TAKEN") setErr({ field: "code", text: "這個門店碼已經被使用，請換一個或留空自動產生。" });
      else if (e?.code === "EMAIL_TAKEN") setErr({ field: "email", text: "這個 Email 已經有帳號。" });
      else setErr({ text: errText(e) });
      revealError();
    }
    setBusy(false);
  }

  if (done)
    return (
      <Page title="門店已建立" back="/" testId="store-created">
        <Card>
          <p className="text-lg font-bold">{done.name}</p>
          <p className="mt-1 text-base text-slate-600">請把下列登入資料交給店長。</p>
        </Card>
        <PasswordOnce email={done.email} password={done.password} />
        <Button onClick={() => navigate(`/stores/${encodeURIComponent(done.id)}`, true)} data-testid="go-store">
          前往門店設定
        </Button>
      </Page>
    );

  return (
    <Page
      title="建立門店"
      back="/"
      testId="store-new"
      footer={
        <Button className="w-full" onClick={submit} disabled={busy} data-testid="create-submit">
          {busy ? "建立中…" : "建立門店"}
        </Button>
      }
    >
      {err && !err.field && (
        <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert">
          {err.text}
        </p>
      )}
      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-bold text-slate-500">門店</h2>
        <Field label="門店名稱" error={show("name")}>
          <input className={inputCls} value={f.name} onChange={set("name")} maxLength={40} aria-invalid={!!show("name")} data-testid="name" />
        </Field>
        <Field label="門店碼（選填）" hint="顧客取號網址用，4～8 個英數字；留空自動產生" error={show("code")}>
          <input className={`${inputCls} uppercase`} value={f.code} onChange={set("code")} maxLength={8} autoCapitalize="characters" aria-invalid={!!show("code")} data-testid="code" />
        </Field>
        <Field label="時區">
          <select className={inputCls} value={f.timezone} onChange={set("timezone")} data-testid="timezone">
            {TIMEZONES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="品牌">
          <select className={inputCls} value={f.brandId} onChange={set("brandId")} data-testid="brand">
            {(brands.data?.brands ?? [{ id: "brand_default", name: "預設品牌" }]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-bold text-slate-500">方案與上限</h2>
        <Field label="到期日（選填）" hint="留空＝不到期">
          <input className={inputCls} type="date" value={f.expires} min={ymd(Date.now())} onChange={set("expires")} data-testid="expires" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="面板上限" error={show("maxDevices")}>
            <input className={inputCls} inputMode="numeric" value={f.maxDevices} onChange={set("maxDevices")} aria-invalid={!!show("maxDevices")} data-testid="max-devices" />
          </Field>
          <Field label="人員上限" error={show("maxStaff")}>
            <input className={inputCls} inputMode="numeric" value={f.maxStaff} onChange={set("maxStaff")} aria-invalid={!!show("maxStaff")} data-testid="max-staff" />
          </Field>
        </div>
        <Field label="廣告容量（MB）" error={show("adMb")}>
          <input className={inputCls} inputMode="numeric" value={f.adMb} onChange={set("adMb")} aria-invalid={!!show("adMb")} data-testid="ad-mb" />
        </Field>
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-bold text-slate-500">第一位店長</h2>
        <Field label="Email（登入帳號）" error={show("email")}>
          <input className={inputCls} type="email" inputMode="email" autoComplete="off" value={f.email} onChange={set("email")} aria-invalid={!!show("email")} data-testid="admin-email" />
        </Field>
        <Field label="店長名稱" error={show("adminName")}>
          <input className={inputCls} value={f.adminName} onChange={set("adminName")} maxLength={20} aria-invalid={!!show("adminName")} data-testid="admin-name" />
        </Field>
        <p className="text-sm text-slate-500">建立後會產生一組初始密碼，只顯示一次，由平台人員轉交店長。</p>
      </Card>
    </Page>
  );
}

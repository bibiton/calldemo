import { useState } from "react";
import { ApiError, login } from "../lib/api";
import { Button, Field, inputCls } from "../ui";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submit() {
    setTouched(true);
    if (!emailOk || !password) return;
    setBusy(true);
    setErr(null);
    try {
      await login(email, password);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "";
      setErr(
        c === "LOCKED"
          ? "密碼錯誤次數過多，帳號已鎖定 15 分鐘。"
          : c === "STORE_SUSPENDED"
            ? "門店服務已暫停，請聯絡平台管理員。"
            : c === "STORE_EXPIRED"
              ? "門店服務已到期，請聯絡平台管理員。"
              : c === "NETWORK"
                ? "網路連線不穩，請稍後再試。"
                : "Email 或密碼錯誤。",
      );
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col" data-testid="login">
      <div className="bg-brand px-6 pt-12 pb-10 text-white">
        <span className="mb-4 block h-4 w-4 rounded-full bg-accent" aria-hidden />
        <h1 className="text-2xl font-black">門店後台</h1>
        <p className="mt-1 text-base text-white/80">叫號系統 · 店長登入</p>
      </div>
      <form
        className="-mt-4 flex flex-col gap-4 rounded-t-3xl bg-[#f4f6fa] px-6 pt-8 pb-10"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Field label="Email" error={touched && !emailOk ? "請輸入正確的 Email" : null}>
          <input className={inputCls} type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={touched && !emailOk} data-testid="email" />
        </Field>
        <Field label="密碼" error={touched && !password ? "請輸入密碼" : null}>
          <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={touched && !password} data-testid="password" />
        </Field>
        {err && (
          <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800 ring-1 ring-red-200" role="alert" data-testid="login-error">
            {err}
          </p>
        )}
        <Button type="submit" className="mt-2 min-h-14 text-lg" disabled={busy} data-testid="login-submit">
          {busy ? "登入中…" : "登入"}
        </Button>
        <p className="text-center text-sm text-slate-500">忘記密碼請聯絡平台管理員重設。</p>
      </form>
    </main>
  );
}

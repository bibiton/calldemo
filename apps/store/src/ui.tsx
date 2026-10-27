/** 門店後台共用元件：手機直版優先（05-apps §0）；觸控目標 ≥ 44px、字級 ≥ 16px。 */
import { useEffect, useState, type ReactNode } from "react";
import { navigate } from "./lib/router";

export function Page({
  title,
  back,
  actions,
  children,
  footer,
  tabs = true,
  testId,
}: {
  title: string;
  back?: string;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tabs?: boolean;
  testId?: string;
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col" data-testid={testId}>
      <header className="sticky top-0 z-30 flex min-h-14 items-center gap-1 bg-brand px-2 text-white shadow-sm">
        {back ? (
          <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl active:bg-white/10" onClick={() => navigate(back)} aria-label="返回" data-testid="back">
            ‹
          </button>
        ) : (
          <span className="w-2" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h1>
        {actions}
      </header>
      <main className={`flex flex-1 flex-col gap-4 px-4 pt-4 ${footer ? "pb-40" : tabs ? "pb-28" : "pb-8"}`}>{children}</main>
      {footer && (
        <div className={`fixed inset-x-0 z-20 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 px-4 pt-3 pb-3 backdrop-blur ${tabs ? "bottom-[calc(4rem+env(safe-area-inset-bottom))]" : "bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"}`}>
          {footer}
        </div>
      )}
      {tabs && <TabBar />}
    </div>
  );
}

const TABS = [
  { to: "/", label: "隊列", icon: "☰" },
  { to: "/reports", label: "報表", icon: "▤" },
  { to: "/ads", label: "廣告", icon: "▶" },
  { to: "/more", label: "設定", icon: "⚙" },
];

export function TabBar() {
  const path = location.pathname;
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to) || (to === "/more" && /^\/(services|counters|staff|devices|hours|voice|settings|pair)/.test(path)));
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-2xl grid-cols-4 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]" aria-label="主選單">
      {TABS.map((t) => (
        <button
          key={t.to}
          className={`relative flex h-16 flex-col items-center justify-center gap-0.5 text-sm font-bold ${active(t.to) ? "text-brand" : "text-slate-500"}`}
          aria-current={active(t.to) ? "page" : undefined}
          onClick={() => navigate(t.to)}
          data-testid={`tab-${t.label}`}
        >
          <span className={`text-lg leading-none ${active(t.to) ? "" : "opacity-70"}`} aria-hidden>
            {t.icon}
          </span>
          {t.label}
          {active(t.to) && <span className="absolute top-0 h-1 w-10 rounded-b bg-accent" aria-hidden />}
        </button>
      ))}
    </nav>
  );
}

export function Card({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${className}`} data-testid={testId}>
      {children}
    </section>
  );
}

type BtnKind = "primary" | "secondary" | "danger" | "ghost";
const BTN: Record<BtnKind, string> = {
  primary: "bg-brand text-white active:bg-brand-600 disabled:bg-slate-400",
  secondary: "bg-white text-brand ring-1 ring-slate-300 active:bg-slate-50 disabled:text-slate-400",
  danger: "bg-white text-red-700 ring-1 ring-red-300 active:bg-red-50 disabled:text-slate-400",
  ghost: "text-brand underline active:bg-slate-100 disabled:text-slate-400",
};
export function Button({
  kind = "primary",
  children,
  className = "",
  ...p
}: { kind?: BtnKind; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-base font-bold disabled:cursor-not-allowed ${BTN[kind]} ${className}`} {...p}>
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-base font-bold text-slate-800">{label}</span>
      {children}
      {hint && !error && <span className="text-sm text-slate-500">{hint}</span>}
      {error && (
        <span className="text-sm font-bold text-red-700" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputCls =
  "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/30 aria-[invalid=true]:border-red-500 disabled:bg-slate-100 disabled:text-slate-500";

export function Toggle({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 min-w-14 shrink-0 items-center justify-center disabled:opacity-50"
      data-testid={testId}
    >
      <span className={`relative h-7 w-12 rounded-full transition-colors ${checked ? "bg-emerald-600" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? "left-[1.375rem]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export function Sheet({ title, onClose, children, footer, testId }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testId?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-slate-100 px-4">
          <h2 className="flex-1 text-lg font-bold">{title}</h2>
          <button className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-slate-500 active:bg-slate-100" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="border-t border-slate-100 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  ok,
  danger,
  onOk,
  onCancel,
  busy,
}: {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
  onOk: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Sheet
      title={title}
      onClose={onCancel}
      testId="confirm"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button kind="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button kind={danger ? "danger" : "primary"} onClick={onOk} disabled={busy} data-testid="confirm-ok" className={danger ? "!bg-red-600 !text-white !ring-0" : ""}>
            {busy ? "處理中…" : ok}
          </Button>
        </div>
      }
    >
      <p className="text-base leading-relaxed text-slate-700">{text}</p>
    </Sheet>
  );
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center" data-testid="empty">
      <p className="text-lg font-bold text-slate-700">{title}</p>
      {text && <p className="text-base text-slate-500">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ text = "載入中…" }: { text?: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="loading">
      <span className="sr-only">{text}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-200/80" />
      ))}
      <p className="text-center text-base text-slate-500">{text}</p>
    </div>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-base text-red-800 ring-1 ring-red-200" role="alert" data-testid="error">
      <span className="flex-1">{text}</span>
      {onRetry && (
        <button className="min-h-11 min-w-11 shrink-0 rounded-lg px-3 font-bold underline active:bg-red-100" onClick={onRetry}>
          重試
        </button>
      )}
    </div>
  );
}

let toastSet: ((t: { text: string; kind: "ok" | "err" } | null) => void) | null = null;
export function toast(text: string, kind: "ok" | "err" = "ok") {
  toastSet?.({ text, kind });
}
export function ToastHost() {
  const [t, setT] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  toastSet = setT;
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), 2600);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  return (
    <div
      className={`fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] mx-auto max-w-md rounded-xl px-4 py-3 text-center text-base font-bold text-white shadow-lg ${t.kind === "ok" ? "bg-emerald-700" : "bg-red-700"}`}
      role="status"
      data-testid="toast"
    >
      {t.text}
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "red" | "amber" }) {
  const c = { slate: "bg-slate-100 text-slate-700", green: "bg-emerald-100 text-emerald-800", red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-900" }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-bold whitespace-nowrap ${c}`}>{children}</span>;
}

/** 讀取資料的共同 hook：loading／error／reload。 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.code === "NETWORK" ? "網路連線不穩，請稍後再試。" : "讀取失敗，請稍後再試。"));
    return () => {
      alive = false;
    };
  }, [n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export const ERR_TEXT: Record<string, string> = {
  NETWORK: "網路連線不穩，請稍後再試。",
  INVALID: "資料格式不正確，請檢查欄位。",
  PREFIX_TAKEN: "這個字首已經被其他服務類別使用。",
  NUMBER_TAKEN: "這個櫃台號碼已經存在。",
  STAFF_LIMIT: "人員數已達方案上限。",
  DEVICE_LIMIT: "叫號面板數已達方案上限，請先移除不用的面板。",
  CODE_NOT_FOUND: "配對碼錯誤或已過期，請在裝置上重新產生。",
  CODE_FORMAT: "請輸入 6 位數字的配對碼。",
  QUOTA_EXCEEDED: "廣告容量不足，請先刪除不用的素材。",
  TOO_LARGE: "檔案太大。",
  TOO_LONG: "影片太長。",
  MIME_INVALID: "不支援的檔案格式。",
  HASH_MISMATCH: "上傳內容損毀，請重新上傳。",
  SIZE_MISMATCH: "上傳中斷，請重新上傳。",
};
export const errText = (e: any, fallback = "操作失敗，請稍後再試。") => ERR_TEXT[e?.code] ?? fallback;

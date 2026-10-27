import { useEffect, useRef, useState } from "react";
import { normalizePhone, validateName } from "@qcs/shared";
import { api, ApiError } from "./lib/api";
import { unlockSound } from "./lib/alerts";
import { requestSubscription, saveSubscription, type PushState } from "./lib/push";
import { Notice, Shell } from "./Shell";
import { TicketPage } from "./TicketPage";
import { Resume } from "./Resume";
import { pushFlag, savedTicket, type Saved, type StoreLite, type Ticket } from "./saved";

interface Service {
  id: string;
  name: string;
  prefix: string;
  waiting: number;
}
type PushInfo = { publicKey: string } | null;

const ACTIVE = ["waiting", "called", "serving", "skipped"];

const ERR: Record<string, string> = {
  QR_EXPIRED: "QR Code 已過期，請重新掃描店內叫號面板上的 QR Code。",
  QR_INVALID: "QR Code 無效，請重新掃描店內叫號面板上的 QR Code。",
  STORE_SUSPENDED: "門店目前暫停服務，請洽櫃台人員。",
  STORE_EXPIRED: "門店目前暫停服務，請洽櫃台人員。",
  STORE_NOT_FOUND: "找不到這家門店，請重新掃描 QR Code。",
  SESSION_INVALID: "取號時間已超過 10 分鐘，請重新掃描 QR Code。",
  SESSION_USED: "這次掃碼已取過號，如需再取請重新掃描 QR Code。",
  PHONE_ACTIVE: "此手機已有進行中號碼，請洽櫃台。",
  PHONE_INVALID: "手機號碼格式不正確。",
  NAME_INVALID: "請輸入 1～20 字的姓名。",
  CONSENT_REQUIRED: "請先勾選同意個資使用說明。",
  NETWORK: "網路連線不穩，請稍後再試。",
};
const msg = (e: unknown) => (e instanceof ApiError ? ERR[e.code] ?? "發生錯誤，請洽櫃台人員。" : "發生錯誤，請洽櫃台人員。");

type View =
  | { k: "loading" }
  | { k: "error"; text: string }
  | { k: "noQr" }
  | { k: "resume" }
  | { k: "service"; session: string; store: StoreLite; services: Service[]; push: PushInfo }
  | { k: "form"; session: string; store: StoreLite; service: Service; push: PushInfo }
  | { k: "ticket"; saved: Saved; ticket: Ticket; existing: boolean; pendingPush?: Promise<PushState> | null };

export function App() {
  const [view, setView] = useState<View>({ k: "loading" });

  useEffect(() => {
    void (async () => {
      const m = /^\/s\/([^/]+)/.exec(location.pathname);
      const code = m ? decodeURIComponent(m[1]) : null;
      const q = new URLSearchParams(location.search);
      const saved = savedTicket.get();
      if (saved && (!code || saved.store.code === code)) {
        try {
          const r = await api<{ ticket: Ticket; push: PushInfo }>("/api/tickets/me", { token: saved.token });
          if (ACTIVE.includes(r.ticket.status)) {
            const s2 = { ...saved, push: r.push };
            savedTicket.set(s2);
            return setView({ k: "ticket", saved: s2, ticket: r.ticket, existing: false });
          }
        } catch {
          /* 過期就重新取號 */
        }
        savedTicket.del();
      }
      // 主畫面 app 的起始頁（manifest start_url）／通知點擊網址：沒有號碼時讓顧客輸入轉交碼
      if (!code && /^\/(resume|t\/)/.test(location.pathname)) return setView({ k: "resume" });
      if (!code || !q.get("w") || !q.get("k")) return setView({ k: "noQr" });
      try {
        const r = await api<{ sessionToken: string; store: StoreLite; services: Service[]; push: PushInfo }>(
          `/api/s/${encodeURIComponent(code)}/session?w=${encodeURIComponent(q.get("w")!)}&k=${encodeURIComponent(q.get("k")!)}`,
        );
        if (r.services.length === 1) setView({ k: "form", session: r.sessionToken, store: r.store, service: r.services[0], push: r.push });
        else setView({ k: "service", session: r.sessionToken, store: r.store, services: r.services, push: r.push });
      } catch (e) {
        setView({ k: "error", text: msg(e) });
      }
    })();
  }, []);

  switch (view.k) {
    case "loading":
      return <Shell><p className="py-16 text-center text-slate-500">載入中…</p></Shell>;
    case "error":
      return <Shell><Notice title="無法取號" text={view.text} /></Shell>;
    case "noQr":
      return <Shell><Notice title="請掃描 QR Code 取號" text="請用手機相機掃描店內叫號面板右下角的 QR Code。" /></Shell>;
    case "resume":
      return <Resume onDone={(saved, ticket) => { savedTicket.set(saved); setView({ k: "ticket", saved, ticket, existing: false }); }} />;
    case "service":
      return (
        <Shell storeName={view.store.name} step={1}>
          <h2 className="mb-4 text-xl font-bold">請選擇服務</h2>
          <ul className="flex flex-col gap-3">
            {view.services.map((s) => (
              <li key={s.id}>
                <button
                  className="flex min-h-16 w-full items-center justify-between rounded-2xl bg-white px-5 py-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
                  onClick={() => setView({ k: "form", session: view.session, store: view.store, service: s, push: view.push })}
                  data-testid={`service-${s.prefix}`}
                >
                  <span className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-black text-white">{s.prefix}</span>
                    <span className="text-lg font-bold">{s.name}</span>
                  </span>
                  <span className="text-base text-slate-500">
                    等候 <b className="text-slate-900">{s.waiting}</b> 位
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Shell>
      );
    case "form":
      return <TakeForm view={view} onBack={() => location.reload()} onDone={(saved, ticket, existing, pendingPush) => setView({ k: "ticket", saved, ticket, existing, pendingPush })} />;
    case "ticket":
      return <TicketPage saved={view.saved} initial={view.ticket} existing={view.existing} pendingPush={view.pendingPush} onReset={() => { savedTicket.del(); setView({ k: "noQr" }); }} />;
  }
}

function TakeForm({
  view,
  onBack,
  onDone,
}: {
  view: { session: string; store: StoreLite; service: Service; push: PushInfo };
  onBack: () => void;
  onDone: (s: Saved, t: Ticket, existing: boolean, pendingPush: Promise<PushState> | null) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState({ name: false, phone: false, consent: false });
  const errRef = useRef<HTMLParagraphElement | null>(null);
  const phoneOk = !!normalizePhone(phone);
  const nameOk = !!validateName(name);
  const canSubmit = phoneOk && nameOk && consent && !busy;

  async function submit() {
    setTouched({ name: true, phone: true, consent: true });
    if (!canSubmit) return;
    // 同一次點擊（07 §2）：①解鎖響鈴 ②請求通知權限＋訂閱（不擋取號）③送出取號
    unlockSound();
    const subP = view.push ? requestSubscription(view.push.publicKey) : null;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ticket: Ticket; ticketToken: string; existing: boolean; store: StoreLite }>(`/api/s/${encodeURIComponent(view.store.code)}/tickets`, {
        method: "POST",
        body: JSON.stringify({ session: view.session, serviceId: view.service.id, name, phone, consent }),
      });
      const saved: Saved = { token: r.ticketToken, ticketId: r.ticket.id, store: r.store, push: view.push };
      savedTicket.set(saved);
      const pending = subP
        ? subP.then(async (x): Promise<PushState> => {
            if (!x.sub) return x.state;
            if (!(await saveSubscription(saved.ticketId, saved.token, x.sub))) return "unsupported";
            pushFlag.set(saved.ticketId);
            return "on";
          })
        : null;
      onDone(saved, r.ticket, r.existing, pending);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
      requestAnimationFrame(() => errRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
  }

  return (
    <Shell storeName={view.store.name} step={2}>
      <button className="mb-3 min-h-11 self-start text-base text-brand underline" onClick={onBack}>
        ‹ 重新選擇服務
      </button>
      <p className="mb-4 text-base text-slate-600">
        服務：<b className="text-slate-900">{view.service.prefix} {view.service.name}</b>（等候 {view.service.waiting} 位）
      </p>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <label className="flex flex-col gap-2">
          <span className="text-base font-bold">姓名</span>
          <input
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            autoComplete="name"
            maxLength={20}
            placeholder="王小明"
            aria-invalid={touched.name && !nameOk}
            data-testid="name"
          />
          {touched.name && !nameOk && <span className="text-sm text-red-600">請輸入 1～20 字的姓名</span>}
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-base font-bold">手機</span>
          <input
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-4 text-base tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
            inputMode="tel"
            autoComplete="tel"
            placeholder="0912345678"
            aria-invalid={touched.phone && !phoneOk}
            data-testid="phone"
          />
          {touched.phone && !phoneOk && <span className="text-sm text-red-600">請輸入台灣手機號碼（09 開頭共 10 碼）</span>}
          <span className="text-sm text-slate-500">只供店員現場聯繫，系統不會發送簡訊。</span>
        </label>
        <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-brand" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="consent" />
            <span className="text-base leading-relaxed">我同意個資使用說明</span>
          </label>
          {touched.consent && !consent && <p className="text-sm text-red-600" data-testid="consent-hint">請勾選同意後才能取號</p>}
          <button type="button" className="mt-1 min-h-11 text-sm text-brand underline" onClick={() => setShowTerms((x) => !x)} aria-expanded={showTerms}>
            {showTerms ? "收合說明" : "查看說明"}
          </button>
          {showTerms && (
            <p className="mt-2 text-sm leading-relaxed text-slate-600" data-testid="terms">
              蒐集目的：叫號與現場聯繫。姓名與手機原文於當日營業結束後刪除；遮罩後資料與不可逆編碼保存 90 天供統計後刪除。
            </p>
          )}
        </div>
        {error && <p ref={errRef} className="rounded-xl bg-red-50 p-3 text-base text-red-700" role="alert">{error}</p>}
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md bg-gradient-to-t from-[#f4f6fa] via-[#f4f6fa] to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="submit"
            className="min-h-14 w-full rounded-2xl bg-brand text-lg font-bold text-white shadow-lg disabled:bg-slate-400"
            disabled={busy}
            data-testid="submit"
          >
            {busy ? "取號中…" : "開啟提醒並取號"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

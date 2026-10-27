import { useEffect, useRef, useState } from "react";
import { normalizePhone, validateName, QcsSocket } from "@qcs/shared";
import { api, ApiError } from "./lib/api";
import { store, wsUrl } from "./lib/env";

interface Service {
  id: string;
  name: string;
  prefix: string;
  waiting: number;
}
interface StoreLite {
  id: string;
  code: string;
  name: string;
  logoUrl?: string | null;
}
interface Ticket {
  id: string;
  number: string;
  status: string;
  counterNo: number | null;
  ahead: number;
  etaMin: number;
}
interface Saved {
  token: string;
  ticketId: string;
  store: StoreLite;
}

const KEY = "qcs.customer.ticket";
const ACTIVE = ["waiting", "called", "serving"];

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

let audioCtx: AudioContext | null = null;
/** 「開啟提醒並取號」同一次點擊：解鎖音效（播 0.1 秒靜音）＋請求通知權限（07 §2）。 */
function unlockAlerts() {
  try {
    const C: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    audioCtx = audioCtx ?? new C();
    void audioCtx.resume();
    const b = audioCtx.createBuffer(1, audioCtx.sampleRate / 10, audioCtx.sampleRate);
    const s = audioCtx.createBufferSource();
    s.buffer = b;
    s.connect(audioCtx.destination);
    s.start();
  } catch {
    /* 不支援就略過 */
  }
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
  } catch {
    /* ignore */
  }
}

function ring() {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.5);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.5 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.5 + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + i * 0.5);
    o.stop(t0 + i * 0.5 + 0.45);
  }
}

function loadSaved(): Saved | null {
  try {
    return JSON.parse(store.get(KEY) ?? "null");
  } catch {
    return null;
  }
}

type View =
  | { k: "loading" }
  | { k: "error"; text: string }
  | { k: "noQr" }
  | { k: "service"; session: string; store: StoreLite; services: Service[] }
  | { k: "form"; session: string; store: StoreLite; service: Service }
  | { k: "ticket"; saved: Saved; ticket: Ticket; existing: boolean };

export function App() {
  const [view, setView] = useState<View>({ k: "loading" });

  useEffect(() => {
    void (async () => {
      const m = /^\/s\/([^/]+)/.exec(location.pathname);
      const code = m ? decodeURIComponent(m[1]) : null;
      const q = new URLSearchParams(location.search);
      const saved = loadSaved();
      if (saved && (!code || saved.store.code === code)) {
        try {
          const r = await api<{ ticket: Ticket }>("/api/tickets/me", { token: saved.token });
          if (ACTIVE.includes(r.ticket.status)) return setView({ k: "ticket", saved, ticket: r.ticket, existing: false });
        } catch {
          /* 過期就重新取號 */
        }
        store.del(KEY);
      }
      if (!code || !q.get("w") || !q.get("k")) return setView({ k: "noQr" });
      try {
        const r = await api<{ sessionToken: string; store: StoreLite; services: Service[] }>(
          `/api/s/${encodeURIComponent(code)}/session?w=${encodeURIComponent(q.get("w")!)}&k=${encodeURIComponent(q.get("k")!)}`,
        );
        if (r.services.length === 1) setView({ k: "form", session: r.sessionToken, store: r.store, service: r.services[0] });
        else setView({ k: "service", session: r.sessionToken, store: r.store, services: r.services });
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
    case "service":
      return (
        <Shell storeName={view.store.name} step={1}>
          <h2 className="mb-4 text-xl font-bold">請選擇服務</h2>
          <ul className="flex flex-col gap-3">
            {view.services.map((s) => (
              <li key={s.id}>
                <button
                  className="flex min-h-16 w-full items-center justify-between rounded-2xl bg-white px-5 py-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
                  onClick={() => setView({ k: "form", session: view.session, store: view.store, service: s })}
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
      return <TakeForm view={view} onBack={() => location.reload()} onDone={(saved, ticket, existing) => setView({ k: "ticket", saved, ticket, existing })} />;
    case "ticket":
      return <TicketPage saved={view.saved} initial={view.ticket} existing={view.existing} onReset={() => { store.del(KEY); setView({ k: "noQr" }); }} />;
  }
}

function Shell({ children, storeName, step }: { children: React.ReactNode; storeName?: string; step?: number }) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="flex items-center justify-between bg-brand px-4 py-3 text-white">
        <span className="flex items-center gap-2 text-lg font-bold">
          <span className="h-3 w-3 rounded-full bg-accent" aria-hidden />
          {storeName ?? "線上取號"}
        </span>
        {step && <span className="text-sm text-white/80">步驟 {step} / 3</span>}
      </header>
      <main className="flex flex-1 flex-col px-4 pt-5 pb-28">{children}</main>
    </div>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-10 rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200" role="status">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-3 text-base leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

function TakeForm({
  view,
  onBack,
  onDone,
}: {
  view: { session: string; store: StoreLite; service: Service };
  onBack: () => void;
  onDone: (s: Saved, t: Ticket, existing: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState({ name: false, phone: false });
  const phoneOk = !!normalizePhone(phone);
  const nameOk = !!validateName(name);
  const canSubmit = phoneOk && nameOk && consent && !busy;

  async function submit() {
    setTouched({ name: true, phone: true });
    if (!canSubmit) return;
    unlockAlerts();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ticket: Ticket; ticketToken: string; existing: boolean; store: StoreLite }>(`/api/s/${encodeURIComponent(view.store.code)}/tickets`, {
        method: "POST",
        body: JSON.stringify({ session: view.session, serviceId: view.service.id, name, phone, consent }),
      });
      const saved: Saved = { token: r.ticketToken, ticketId: r.ticket.id, store: r.store };
      store.set(KEY, JSON.stringify(saved));
      onDone(saved, r.ticket, r.existing);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
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
          <button type="button" className="mt-1 min-h-11 text-sm text-brand underline" onClick={() => setShowTerms((x) => !x)} aria-expanded={showTerms}>
            {showTerms ? "收合說明" : "查看說明"}
          </button>
          {showTerms && (
            <p className="mt-2 text-sm leading-relaxed text-slate-600" data-testid="terms">
              蒐集目的：叫號與現場聯繫。姓名與手機原文於當日營業結束後刪除；遮罩後資料與不可逆編碼保存 90 天供統計後刪除。
            </p>
          )}
        </div>
        {error && <p className="rounded-xl bg-red-50 p-3 text-base text-red-700" role="alert">{error}</p>}
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

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;

function TicketPage({ saved, initial, existing, onReset }: { saved: Saved; initial: Ticket; existing: boolean; onReset: () => void }) {
  const [t, setT] = useState<Ticket>(initial);
  const [alert, setAlert] = useState(initial.status === "called");
  const [conn, setConn] = useState("connecting");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const sockRef = useRef<QcsSocket | null>(null);

  useEffect(() => {
    const make = () =>
      new QcsSocket({
        url: () => wsUrl(`/ws/store/${saved.store.id}?role=customer`),
        protocols: () => ["qcs.v1", `auth.${saved.token}`],
        gapCheck: false,
        onStatus: setConn,
        onMessage: (m) => {
          if (m.t !== "evt") return;
          if (m.type === "snapshot" && m.data.mine) setT((p) => ({ ...p, ...m.data.mine }));
          else if (m.type === "queue.position") setT((p) => ({ ...p, ...m.data, id: p.id }));
          else if (m.type?.startsWith("ticket.") && m.data?.id === saved.ticketId) {
            setT((p) => ({ ...p, ...m.data }));
            if (m.type === "ticket.called") {
              setAlert(true);
              ring();
              try {
                navigator.vibrate?.([400, 200, 400, 200, 400]);
              } catch {
                /* iOS 不支援 */
              }
            }
          }
        },
      });
    // 前景才連線；背景交給 Web Push（M2）（04 §6）
    const start = () => {
      if (sockRef.current) return;
      sockRef.current = make();
      sockRef.current.start();
    };
    const stop = () => {
      sockRef.current?.stop(1000);
      sockRef.current = null;
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [saved]);

  async function cancel() {
    try {
      await api(`/api/tickets/${saved.ticketId}/cancel`, { method: "POST", token: saved.token });
      setT((p) => ({ ...p, status: "cancelled" }));
    } catch {
      /* 已被叫號等狀態不可取消 */
    }
    setConfirmCancel(false);
  }

  const ended = ["done", "no_show", "cancelled"].includes(t.status);
  return (
    <Shell storeName={saved.store.name} step={ended ? undefined : 3}>
      {existing && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-base text-amber-900" role="status">您已有號碼，以下是您原本的號碼。</p>}
      <section className="rounded-3xl bg-white px-5 py-7 text-center shadow-sm ring-1 ring-slate-200" data-testid="ticket" data-status={t.status}>
        <p className="text-base text-slate-500">您的號碼</p>
        <p className="mt-1 text-7xl font-black tracking-wider text-brand tabular-nums" data-testid="my-number">{t.number}</p>
        <div className="mt-4 text-lg" data-testid="ticket-status">
          {t.status === "waiting" && (
            <>
              <p>前面還有 <b className="text-2xl tabular-nums" data-testid="ahead">{t.ahead}</b> 位</p>
              <p className="mt-1 text-base text-slate-500">預估約 {Math.max(1, t.etaMin)} 分鐘</p>
            </>
          )}
          {(t.status === "called" || t.status === "serving") && <p className="text-xl font-bold text-red-600">輪到您了！請到 {t.counterNo ?? ""} 號櫃台</p>}
          {t.status === "skipped" && <p className="text-xl font-bold text-red-600">已過號，請洽櫃台</p>}
          {t.status === "done" && <p>服務已完成，謝謝光臨</p>}
          {t.status === "no_show" && <p>號碼已失效，如需服務請洽櫃台</p>}
          {t.status === "cancelled" && <p>號碼已取消</p>}
        </div>
      </section>

      {!ended && (
        <section className="mt-4 rounded-2xl bg-white p-4 text-base leading-relaxed ring-1 ring-slate-200">
          <p className="font-bold">🔔 叫到號時這個頁面會響鈴提醒</p>
          <p className="text-slate-600">請保持此頁開啟、不要鎖定螢幕。</p>
          {isIos() && !standalone() && <p className="mt-2 text-slate-600">iPhone 可點「分享 → 加入主畫面」以便在背景接收提醒。</p>}
          {conn !== "open" && <p className="mt-2 text-sm text-amber-700">連線中…</p>}
        </section>
      )}

      <div className="mt-6">
        {t.status === "waiting" && !confirmCancel && (
          <button className="min-h-12 w-full rounded-2xl bg-white text-base font-bold text-red-600 ring-1 ring-red-200" onClick={() => setConfirmCancel(true)}>
            取消號碼
          </button>
        )}
        {confirmCancel && (
          <div className="flex gap-3">
            <button className="min-h-12 flex-1 rounded-2xl bg-white text-base ring-1 ring-slate-300" onClick={() => setConfirmCancel(false)}>保留號碼</button>
            <button className="min-h-12 flex-1 rounded-2xl bg-red-600 text-base font-bold text-white" onClick={() => void cancel()}>確定取消</button>
          </div>
        )}
        {ended && (
          <button className="min-h-12 w-full rounded-2xl bg-white text-base ring-1 ring-slate-300" onClick={onReset}>完成</button>
        )}
      </div>

      {alert && (t.status === "called" || t.status === "serving") && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-red-600 px-6 text-center text-white animate-[qcs-blink_1s_ease-in-out_infinite]" role="alertdialog" aria-label="叫號提醒" data-testid="called-alert">
          <p className="text-2xl font-bold">輪到您了！</p>
          <p className="text-8xl font-black tabular-nums">{t.number}</p>
          <p className="text-3xl font-bold">請到 {t.counterNo ?? ""} 號櫃台</p>
          <button className="mt-6 min-h-14 rounded-2xl bg-white px-10 text-xl font-bold text-red-700" onClick={() => setAlert(false)}>我知道了</button>
        </div>
      )}
    </Shell>
  );
}

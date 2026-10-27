import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QcsSocket, ulid, type CounterInfo, type ServiceInfo, type StaffTicket } from "@qcs/shared";
import { api, ApiError } from "./lib/api";
import { decodeJwt, store, wsUrl } from "./lib/env";
import { StaffPair } from "./Pair";

const DEVICE_KEY = "qcs.staff.device";
const SESSION_KEY = "qcs.staff.session";
const COUNTER_KEY = "qcs.staff.counter";

interface DeviceInfo {
  store: { id: string; name: string };
  staff: { id: string; displayName: string }[];
  counters: CounterInfo[];
  services: ServiceInfo[];
}
interface Session {
  token: string;
  expiresAt: number;
  user: { id: string; displayName: string };
}

function readDevice(): string | null {
  const q = new URLSearchParams(location.search).get("device");
  if (q) {
    store.set(DEVICE_KEY, q);
    history.replaceState(null, "", location.pathname);
    return q;
  }
  return store.get(DEVICE_KEY);
}
function readSession(): Session | null {
  try {
    const s = JSON.parse(store.get(SESSION_KEY) ?? "null") as Session | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function App() {
  const [device, setDevice] = useState(readDevice);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unbound, setUnbound] = useState<string | null>(null);
  const [infoN, setInfoN] = useState(0);
  const [session, setSession] = useState<Session | null>(readSession);
  const [counterId, setCounterId] = useState<string | null>(() => store.get(COUNTER_KEY));

  useEffect(() => {
    if (!device) return;
    api<DeviceInfo>("/api/staff/device", { token: device })
      .then(setInfo)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          // 綁定已被店長解除：清掉舊 token，回到配對畫面
          store.del(DEVICE_KEY);
          store.del(SESSION_KEY);
          setUnbound("這支手機的綁定已解除，請重新配對。");
          setDevice(null);
        } else setErr(e instanceof ApiError && e.status === 403 ? "門店目前暫停服務。" : "無法連線，請稍後再試。");
      });
  }, [device, infoN]);

  const logout = () => {
    store.del(SESSION_KEY);
    setSession(null);
  };

  if (!device)
    return (
      <StaffPair
        notice={unbound}
        onPaired={(t) => {
          store.set(DEVICE_KEY, t);
          setUnbound(null);
          setInfo(null);
          setDevice(t);
        }}
      />
    );
  if (err) return <Centered title="無法使用" text={err} />;
  if (!info) return <Centered title="載入中…" />;
  if (!session || decodeJwt(session.token)?.store_id !== info.store.id)
    return <Login info={info} device={device} onLogin={(s) => { store.set(SESSION_KEY, JSON.stringify(s)); setSession(s); }} />;
  const counter = info.counters.find((c) => c.id === counterId);
  if (!counter)
    return <PickCounter info={info} onPick={(id) => { store.set(COUNTER_KEY, id); setCounterId(id); }} onLogout={logout} />;
  return <Desk info={info} session={session} counter={counter} onSwitchCounter={() => setCounterId(null)} onLogout={logout} onSettingsChanged={() => setInfoN((k) => k + 1)} onRevoked={() => setInfoN((k) => k + 1)} />;
}

function Centered({ title, text }: { title: string; text?: string }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-bold text-brand">{title}</h1>
      {text && <p className="text-base leading-relaxed text-slate-600">{text}</p>}
    </main>
  );
}

function Login({ info, device, onLogin }: { info: DeviceInfo; device: string; onLogin: (s: Session) => void }) {
  const [userId, setUserId] = useState<string | null>(info.staff.length === 1 ? info.staff[0].id : null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = info.staff.find((u) => u.id === userId);

  async function submit(p: string) {
    setBusy(true);
    setErr(null);
    try {
      onLogin(await api<Session>("/api/staff/login", { method: "POST", token: device, body: JSON.stringify({ userId, pin: p }) }));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 423 ? "嘗試次數過多，請 15 分鐘後再試。" : "PIN 錯誤，請再試一次。");
      setPin("");
      setBusy(false);
    }
  }
  const press = (d: string) => {
    if (busy) return;
    const p = (pin + d).slice(0, 6);
    setPin(p);
    if (p.length === 6) void submit(p);
  };

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col bg-white">
      <header className="bg-brand px-4 py-4 text-white">
        <p className="text-sm text-white/70">{info.store.name}</p>
        <h1 className="text-xl font-bold">人員登入</h1>
      </header>
      {!user ? (
        <section className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-bold text-slate-600">請選擇您的名字</h2>
          {info.staff.map((u) => (
            <button key={u.id} className="min-h-14 rounded-2xl bg-slate-100 px-5 text-left text-lg font-bold active:bg-slate-200" onClick={() => setUserId(u.id)} data-testid={`staff-${u.id}`}>
              {u.displayName}
            </button>
          ))}
        </section>
      ) : (
        <section className="flex flex-1 flex-col items-center gap-4 p-4">
          <button className="min-h-11 self-start text-base text-brand underline" onClick={() => { setUserId(null); setPin(""); }}>‹ 換人</button>
          <p className="text-lg"><b>{user.displayName}</b>，請輸入 6 位 PIN</p>
          <div className="flex gap-3" aria-label={`已輸入 ${pin.length} 位`} data-testid="pin-dots">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? "bg-brand" : "bg-slate-300"}`} />
            ))}
          </div>
          {err && <p className="text-base text-red-600" role="alert">{err}</p>}
          <div className="mt-auto grid w-full grid-cols-3 gap-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
              k === "" ? <span key={i} /> : (
                <button
                  key={i}
                  className="min-h-16 rounded-2xl bg-slate-100 text-2xl font-bold active:bg-slate-200 disabled:opacity-50"
                  disabled={busy}
                  aria-label={k === "⌫" ? "刪除" : k}
                  onClick={() => (k === "⌫" ? setPin((p) => p.slice(0, -1)) : press(k))}
                  data-testid={`pin-${k === "⌫" ? "del" : k}`}
                >
                  {k}
                </button>
              ),
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function PickCounter({ info, onPick, onLogout }: { info: DeviceInfo; onPick: (id: string) => void; onLogout: () => void }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col bg-white">
      <header className="flex items-center justify-between bg-brand px-4 py-4 text-white">
        <h1 className="text-xl font-bold">選擇櫃台</h1>
        <button className="min-h-11 px-2 text-base underline" onClick={onLogout}>登出</button>
      </header>
      <section className="grid grid-cols-2 gap-3 p-4">
        {info.counters.map((c) => (
          <button key={c.id} className="min-h-20 rounded-2xl bg-slate-100 text-xl font-bold active:bg-slate-200" onClick={() => onPick(c.id)} data-testid={`counter-${c.number}`}>
            {c.name}
          </button>
        ))}
      </section>
    </main>
  );
}

type Sheet = { k: "ticket"; t: StaffTicket } | { k: "transfer"; t: StaffTicket } | { k: "create" } | null;

function minutesAgo(ms: number) {
  return Math.max(0, Math.round((Date.now() - ms) / 60_000));
}

function Desk({
  info,
  session,
  counter,
  onSwitchCounter,
  onLogout,
  onSettingsChanged,
  onRevoked,
}: {
  info: DeviceInfo;
  session: Session;
  counter: CounterInfo;
  onSwitchCounter: () => void;
  onLogout: () => void;
  onSettingsChanged: () => void;
  onRevoked: () => void;
}) {
  const [tickets, setTickets] = useState<Map<string, StaffTicket>>(new Map());
  const [conn, setConn] = useState("connecting");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("all");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [devAlert, setDevAlert] = useState<string | null>(null);
  const sock = useRef<QcsSocket | null>(null);
  const pending = useRef(new Map<string, { msg: any; resolve: (a: any) => void }>());

  useEffect(() => {
    const s = new QcsSocket({
      url: (lastSeq) => wsUrl(`/ws/store/${info.store.id}?role=staff${lastSeq != null ? `&lastSeq=${lastSeq}` : ""}`),
      protocols: () => ["qcs.v1", `auth.${session.token}`],
      onStatus: (st, code) => {
        setConn(st);
        // 4001＝人員被停用／重設 PIN／手機被解除：回到登入（或配對）畫面
        if (code === 4001) {
          s.stop();
          store.del(SESSION_KEY);
          onRevoked();
          onLogout();
        }
        // 重連後重送未 ack 的指令（同 cmdId，DO 端冪等，不會叫兩次號）
        if (st === "open") for (const p of pending.current.values()) s.send(p.msg);
      },
      onMessage: (m) => {
        if (m.t === "ack") {
          const p = pending.current.get(m.cmdId);
          if (p) {
            pending.current.delete(m.cmdId);
            p.resolve(m);
          }
          return;
        }
        if (m.t !== "evt") return;
        if (m.type === "snapshot") {
          const all = [...m.data.staff.waiting, ...m.data.staff.active, ...m.data.staff.skipped] as StaffTicket[];
          setTickets(new Map(all.map((t) => [t.id, t])));
          if (Array.isArray(m.data.devices)) {
            const b = m.data.devices.some((d: any) => d.audio === "blocked");
            setDevAlert(b ? "叫號機目前無法出聲，請到面板前按一下遙控器 OK 或點一下畫面" : null);
          }
        } else if (m.type?.startsWith("ticket.") && m.data?.id) {
          setTickets((prev) => new Map(prev).set(m.data.id, m.data as StaffTicket));
        } else if (m.type === "device.status") {
          setDevAlert(m.data.audio === "blocked" ? "叫號機目前無法出聲，請到面板前按一下遙控器 OK 或點一下畫面" : null);
        } else if (m.type === "store.closed") {
          s.send({ t: "resync" });
        } else if (m.type === "settings.changed") {
          s.send({ t: "resync" });
          onSettingsChanged(); // 櫃台／服務類別可能變了
        }
      },
    });
    sock.current = s;
    s.start();
    return () => s.stop();
  }, [info.store.id, session.token]);

  const send = useCallback(async (cmd: string, args: Record<string, unknown>): Promise<any> => {
    const cmdId = ulid();
    const msg = { t: "cmd", cmdId, cmd, args };
    setBusy(cmd);
    const ack = await new Promise<any>((resolve) => {
      pending.current.set(cmdId, { msg, resolve });
      sock.current?.send(msg);
      setTimeout(() => {
        if (pending.current.has(cmdId)) setToast("網路較慢，指令會在連線恢復後送出");
      }, 4000);
    });
    setBusy(null);
    if (!ack.ok) setToast(ERRS[ack.error] ?? `操作失敗（${ack.error}）`);
    return ack;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const list = useMemo(() => [...tickets.values()], [tickets]);
  const allowed = counter.serviceIds.length ? counter.serviceIds : info.services.map((s) => s.id);
  const waiting = list.filter((t) => t.status === "waiting").sort((a, b) => a.createdAt - b.createdAt);
  const skipped = list.filter((t) => t.status === "skipped");
  const current = list
    .filter((t) => (t.status === "called" || t.status === "serving") && t.counterId === counter.id)
    .sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0))[0];
  const svcName = (id: string) => info.services.find((s) => s.id === id);
  const shown = tab === "all" ? waiting : waiting.filter((t) => t.serviceId === tab);
  const offline = conn !== "open";
  const dis = offline || !!busy;

  const reveal = async (id: string) => {
    const a = await send("revealPhone", { ticketId: id });
    if (a.ok) setRevealed(a.result.phone);
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-slate-100">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-2 bg-brand px-3 py-2 text-white">
        <button className="flex min-h-11 items-center gap-1 rounded-xl px-2 text-lg font-bold" onClick={onSwitchCounter} data-testid="counter-switch">
          {counter.name} <span aria-hidden>▾</span>
        </button>
        <div className="flex items-center gap-1">
          <button className="min-h-11 rounded-xl px-3 text-base font-bold ring-1 ring-white/40" onClick={() => setSheet({ k: "create" })} data-testid="create-open">
            ＋代客取號
          </button>
          <span className="max-w-20 truncate px-1 text-base">{session.user.displayName}</span>
          <button className="min-h-11 min-w-11 rounded-xl text-lg" aria-label="登出" onClick={onLogout}>⏻</button>
        </div>
      </header>

      {offline && <p className="bg-amber-400 px-4 py-2 text-center text-base font-bold text-black" role="status" data-testid="offline">重新連線中…</p>}
      {devAlert && <p className="bg-red-600 px-4 py-2 text-base text-white" role="alert">{devAlert}</p>}

      <main className="flex flex-1 flex-col gap-3 p-3 pb-56">
        <section className="rounded-2xl bg-white p-4 shadow-sm" data-testid="current">
          <p className="text-sm text-slate-500">目前</p>
          {current ? (
            <>
              <p className="text-5xl font-black tracking-wide text-brand tabular-nums" data-testid="current-number">{current.number}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-lg">
                <span className="font-bold">{current.name ?? "（未留姓名）"}</span>
                {current.phoneMasked && (
                  <span className="flex items-center gap-1 tabular-nums">
                    {revealed ?? current.phoneMasked}
                    <button
                      className="min-h-11 min-w-11 rounded-xl text-xl active:bg-slate-100 select-none"
                      aria-label="按住顯示完整手機"
                      onPointerDown={() => void reveal(current.id)}
                      onPointerUp={() => setRevealed(null)}
                      onPointerLeave={() => setRevealed(null)}
                      onContextMenu={(e) => e.preventDefault()}
                      data-testid="reveal"
                    >
                      👁
                    </button>
                  </span>
                )}
              </div>
              <p className="mt-1 text-base text-slate-600">
                狀態：{current.status === "serving" ? "服務中" : "已叫號"}
                {current.recallCount > 0 && `（重叫 ${current.recallCount}）`}
              </p>
            </>
          ) : (
            <p className="py-3 text-lg text-slate-500">尚未叫號</p>
          )}
        </section>

        <section className="rounded-2xl bg-white shadow-sm">
          <div className="flex gap-2 overflow-x-auto border-b border-slate-100 p-2" role="tablist">
            {[{ id: "all", label: `全部 ${waiting.length}` }, ...info.services.map((s) => ({ id: s.id, label: `${s.prefix} ${waiting.filter((t) => t.serviceId === s.id).length}` }))].map((x) => (
              <button key={x.id} role="tab" aria-selected={tab === x.id} className={`min-h-11 shrink-0 rounded-xl px-4 text-base font-bold ${tab === x.id ? "bg-brand text-white" : "bg-slate-100"}`} onClick={() => setTab(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          <ul className="divide-y divide-slate-100" data-testid="waiting-list">
            {shown.length === 0 && <li className="p-4 text-base text-slate-500">目前沒有等候中的號碼</li>}
            {shown.map((t) => (
              <li key={t.id}>
                <button className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-slate-50" onClick={() => setSheet({ k: "ticket", t })}>
                  <span className="w-16 shrink-0 text-xl font-black tabular-nums">{t.number}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base">{t.name ?? "—"}</span>
                    {t.counterId && (
                      <span className="text-sm text-amber-700">→ 指定 {info.counters.find((c) => c.id === t.counterId)?.name ?? "其他櫃台"}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm text-slate-500">{minutesAgo(t.createdAt)} 分</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {skipped.length > 0 && (
          <section className="rounded-2xl bg-white p-2 shadow-sm">
            <h2 className="px-2 py-1 text-base font-bold text-slate-600">過號</h2>
            <ul className="divide-y divide-slate-100">
              {skipped.map((t) => (
                <li key={t.id} className="flex items-center gap-2 px-2 py-2">
                  <span className="w-16 text-lg font-black tabular-nums">{t.number}</span>
                  <span className="min-w-0 flex-1 truncate text-base">{t.name ?? "—"}</span>
                  <button className="min-h-11 rounded-xl bg-slate-100 px-3 text-base font-bold" disabled={dis} onClick={() => void send("requeue", { ticketId: t.id, position: "tail" })}>重新排入</button>
                  <button className="min-h-11 rounded-xl bg-slate-100 px-3 text-base" disabled={dis} onClick={() => void send("noShow", { ticketId: t.id })}>未到</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md bg-white/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur" aria-label="叫號操作">
        <div className="grid grid-cols-4 gap-2">
          <Act label="重叫" disabled={dis || current?.status !== "called"} onClick={() => current && void send("recall", { ticketId: current.id })} id="recall" />
          <Act label="過號" disabled={dis || current?.status !== "called"} onClick={() => current && void send("skip", { ticketId: current.id })} id="skip" />
          <Act label="未到" disabled={dis || current?.status !== "called"} onClick={() => current && void send("noShow", { ticketId: current.id })} id="noshow" />
          <Act label="轉櫃台" disabled={dis || !current} onClick={() => current && setSheet({ k: "transfer", t: current })} id="transfer" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Act label="開始服務" disabled={dis || current?.status !== "called"} onClick={() => current && void send("startServing", { ticketId: current.id })} id="serve" />
          <Act label="完成" disabled={dis || !current} onClick={() => current && void send("finish", { ticketId: current.id })} id="finish" />
        </div>
        <button
          className="mt-2 min-h-16 w-full rounded-2xl bg-brand text-2xl font-black text-white shadow-md active:bg-brand-600 disabled:bg-slate-400"
          disabled={dis}
          onClick={() => void send("callNext", { counterId: counter.id, serviceIds: allowed })}
          data-testid="call-next"
        >
          {busy === "callNext" ? "叫號中…" : "叫下一號"}
        </button>
      </nav>

      {toast && <div className="fixed inset-x-4 bottom-60 z-50 mx-auto max-w-sm rounded-2xl bg-slate-900 px-4 py-3 text-center text-base text-white shadow-lg" role="status" data-testid="toast">{toast}</div>}

      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={() => setSheet(null)}>
          <div className="mx-auto w-full max-w-md rounded-t-3xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()} role="dialog">
            {sheet.k === "ticket" && (
              <>
                <h2 className="text-2xl font-black">{sheet.t.number}</h2>
                <p className="mb-4 text-base text-slate-600">{sheet.t.name ?? "—"} · {svcName(sheet.t.serviceId)?.name}</p>
                <div className="grid gap-2">
                  <button className="min-h-14 rounded-2xl bg-brand text-lg font-bold text-white" disabled={dis} onClick={() => { void send("call", { ticketId: sheet.t.id, counterId: counter.id }); setSheet(null); }}>叫這號到 {counter.name}</button>
                  <button className="min-h-14 rounded-2xl bg-slate-100 text-lg font-bold" onClick={() => setSheet({ k: "transfer", t: sheet.t })}>轉櫃台／服務</button>
                  <button className="min-h-12 rounded-2xl text-base text-slate-600" onClick={() => setSheet(null)}>關閉</button>
                </div>
              </>
            )}
            {sheet.k === "transfer" && (
              <>
                <h2 className="mb-3 text-xl font-bold">{sheet.t.number} 轉到</h2>
                <p className="mb-2 text-sm text-slate-500">櫃台</p>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  {info.counters.filter((c) => c.id !== counter.id).map((c) => (
                    <button key={c.id} className="min-h-12 rounded-2xl bg-slate-100 text-base font-bold" disabled={dis} onClick={() => { void send("transfer", { ticketId: sheet.t.id, toCounterId: c.id }); setSheet(null); }}>{c.name}</button>
                  ))}
                </div>
                <p className="mb-2 text-sm text-slate-500">服務類別</p>
                <div className="grid grid-cols-2 gap-2">
                  {info.services.filter((s) => s.id !== sheet.t.serviceId).map((s) => (
                    <button key={s.id} className="min-h-12 rounded-2xl bg-slate-100 text-base font-bold" disabled={dis} onClick={() => { void send("transfer", { ticketId: sheet.t.id, toServiceId: s.id }); setSheet(null); }}>{s.prefix} {s.name}</button>
                  ))}
                </div>
                <button className="mt-3 min-h-12 w-full rounded-2xl text-base text-slate-600" onClick={() => setSheet(null)}>取消</button>
              </>
            )}
            {sheet.k === "create" && <CreateForm services={info.services} disabled={dis} onSubmit={async (a) => { const r = await send("createTicket", a); if (r.ok) { setToast(`已取號 ${r.result.ticket.number}`); setSheet(null); } }} onClose={() => setSheet(null)} />}
          </div>
        </div>
      )}
    </div>
  );
}

const ERRS: Record<string, string> = {
  QUEUE_EMPTY: "目前沒有可叫的號碼",
  BAD_STATE: "號碼狀態已變更，畫面已更新",
  PHONE_INVALID: "手機格式不正確",
  PHONE_ACTIVE: "此手機已有進行中號碼",
  TICKET_NOT_FOUND: "找不到此號碼",
};

function Act({ label, onClick, disabled, id }: { label: string; onClick: () => void; disabled?: boolean; id: string }) {
  return (
    <button className="min-h-12 rounded-xl bg-slate-100 text-base font-bold active:bg-slate-200 disabled:text-slate-400 disabled:opacity-60" disabled={disabled} onClick={onClick} data-testid={`act-${id}`}>
      {label}
    </button>
  );
}

function CreateForm({ services, disabled, onSubmit, onClose }: { services: ServiceInfo[]; disabled: boolean; onSubmit: (a: Record<string, unknown>) => void; onClose: () => void }) {
  const [svc, setSvc] = useState(services[0]?.id);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ serviceId: svc, name: name || undefined, phone: phone || undefined }); }}>
      <h2 className="text-xl font-bold">代客取號</h2>
      <div className="grid grid-cols-2 gap-2">
        {services.map((s) => (
          <button type="button" key={s.id} className={`min-h-12 rounded-2xl text-base font-bold ${svc === s.id ? "bg-brand text-white" : "bg-slate-100"}`} onClick={() => setSvc(s.id)}>{s.prefix} {s.name}</button>
        ))}
      </div>
      <input className="min-h-12 rounded-xl border border-slate-300 px-4 text-base" placeholder="姓名（選填）" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
      <input className="min-h-12 rounded-xl border border-slate-300 px-4 text-base" placeholder="手機（選填）" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <button className="min-h-14 rounded-2xl bg-brand text-lg font-bold text-white disabled:bg-slate-400" disabled={disabled}>取號</button>
      <button type="button" className="min-h-12 rounded-2xl text-base text-slate-600" onClick={onClose}>取消</button>
    </form>
  );
}

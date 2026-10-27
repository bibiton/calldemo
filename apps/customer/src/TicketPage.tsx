import { useEffect, useRef, useState } from "react";
import { QcsSocket } from "@qcs/shared";
import { api } from "./lib/api";
import { wsUrl } from "./lib/env";
import { ring, vibrate } from "./lib/alerts";
import { isIos, isStandalone, pushSupported, requestSubscription, saveSubscription, type PushState } from "./lib/push";
import { Shell } from "./Shell";
import { ImageCarousel } from "./ImageCarousel";
import { pushFlag, type Saved, type Ticket } from "./saved";

const ENDED = ["done", "no_show", "cancelled"];

export function TicketPage({
  saved,
  initial,
  existing,
  pendingPush,
  onReset,
}: {
  saved: Saved;
  initial: Ticket;
  existing: boolean;
  pendingPush?: Promise<PushState> | null;
  onReset: () => void;
}) {
  const [t, setT] = useState<Ticket>(initial);
  // 已按「我知道了」的叫號（以重叫次數區分）：重叫時會再跳出來
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [conn, setConn] = useState("connecting");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [push, setPush] = useState<PushState>(() => (pushFlag.get(saved.ticketId) ? "on" : pendingPush ? "pending" : "off"));
  const sockRef = useRef<QcsSocket | null>(null);

  // 從表單（小螢幕要捲動）進來時回到頂端：號碼與前面幾位一定在首屏
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!pendingPush) return;
    let alive = true;
    void pendingPush.then((s) => alive && setPush(s));
    return () => {
      alive = false;
    };
  }, [pendingPush]);

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
              ring();
              vibrate();
            }
          }
        },
      });
    // 前景才連線；背景交給 Web Push（04 §6）：等候中大部分時間不佔 DO 連線、不送心跳
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
    if (document.visibilityState !== "hidden") start();
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

  async function enablePush() {
    setPush("pending");
    const r = await requestSubscription(saved.push?.publicKey);
    if (r.sub && (await saveSubscription(saved.ticketId, saved.token, r.sub))) {
      pushFlag.set(saved.ticketId);
      setPush("on");
    } else setPush(r.state === "on" ? "unsupported" : r.state);
  }

  const ended = ENDED.includes(t.status);
  const called = t.status === "called" || t.status === "serving";
  const showAlert = called && dismissed !== t.recallCount;
  return (
    <Shell storeName={saved.store.name} logoUrl={saved.store.logoUrl} step={ended ? undefined : 3}>
      {existing && (
        <p className="mb-3 rounded-xl bg-amber-50 p-3 text-base text-amber-900" role="status">
          您已有號碼，以下是您原本的號碼。
        </p>
      )}
      <section className="rounded-3xl bg-white px-5 py-7 text-center shadow-sm ring-1 ring-slate-200" data-testid="ticket" data-status={t.status}>
        <p className="text-base text-slate-500">您的號碼</p>
        <p className="mt-1 text-7xl font-black tracking-wider text-brand tabular-nums" data-testid="my-number">
          {t.number}
        </p>
        <div className="mt-4 text-lg" data-testid="ticket-status">
          {t.status === "waiting" && (
            <>
              <p>
                前面還有 <b className="text-2xl tabular-nums" data-testid="ahead">{t.ahead}</b> 位
              </p>
              <p className="mt-1 text-base text-slate-500">{t.ahead === 0 ? "下一位就是您，請留意叫號" : `預估約 ${Math.max(1, t.etaMin)} 分鐘`}</p>
            </>
          )}
          {called && <p className="text-xl font-bold text-red-600">輪到您了！請到 {t.counterNo ?? ""} 號櫃台</p>}
          {t.status === "skipped" && <p className="text-xl font-bold text-red-600">已過號，請洽櫃台</p>}
          {t.status === "done" && <p>服務已完成，謝謝光臨</p>}
          {t.status === "no_show" && <p>號碼已失效，如需服務請洽櫃台</p>}
          {t.status === "cancelled" && <p>號碼已取消</p>}
        </div>
      </section>
      {!ended && <NotifyCard saved={saved} push={push} conn={conn} onEnable={() => void enablePush()} />}

      {/* 門店圖片放在提醒卡之後：不把「開啟背景提醒」／iOS 教學推出首屏（ADR-048） */}
      {t.status === "waiting" && !!saved.store.images?.length && <ImageCarousel images={saved.store.images} />}

      <div className="mt-6">
        {t.status === "waiting" && !confirmCancel && (
          <button className="min-h-12 w-full rounded-2xl bg-white text-base font-bold text-red-600 ring-1 ring-red-200" onClick={() => setConfirmCancel(true)}>
            取消號碼
          </button>
        )}
        {confirmCancel && (
          <div className="flex gap-3">
            <button className="min-h-12 flex-1 rounded-2xl bg-white text-base ring-1 ring-slate-300" onClick={() => setConfirmCancel(false)}>
              保留號碼
            </button>
            <button className="min-h-12 flex-1 rounded-2xl bg-red-600 text-base font-bold text-white" onClick={() => void cancel()}>
              確定取消
            </button>
          </div>
        )}
        {ended && (
          <button className="min-h-12 w-full rounded-2xl bg-white text-base ring-1 ring-slate-300" onClick={onReset}>
            完成
          </button>
        )}
      </div>

      {showAlert && (
        <div
          className="fixed inset-0 z-50 flex animate-[qcs-alert-bg_1s_ease-in-out_infinite] flex-col items-center justify-center gap-6 bg-red-600 px-6 text-center text-white"
          role="alertdialog"
          aria-label="叫號提醒"
          data-testid="called-alert"
        >
          <p className="text-2xl font-bold">{t.recallCount ? "再次叫號！" : "輪到您了！"}</p>
          <p className="text-8xl font-black tabular-nums">{t.number}</p>
          <p className="text-3xl font-bold">請到 {t.counterNo ?? ""} 號櫃台</p>
          <button className="mt-6 min-h-14 rounded-2xl bg-white px-10 text-xl font-bold text-red-700" onClick={() => setDismissed(t.recallCount)}>
            我知道了
          </button>
        </div>
      )}
    </Shell>
  );
}

/** 提醒方式卡片：前景響鈴一定有；背景推播依支援度顯示狀態、開啟按鈕或 iOS 加入主畫面教學（07 §2、§3）。 */
function NotifyCard({ saved, push, conn, onEnable }: { saved: Saved; push: PushState; conn: string; onEnable: () => void }) {
  const iosSafari = isIos() && !isStandalone();
  const canPush = !!saved.push?.publicKey && pushSupported();
  return (
    <section className="mt-4 rounded-2xl bg-white p-4 text-base leading-relaxed ring-1 ring-slate-200" data-testid="notify-card" data-push={push}>
      <p className="font-bold">🔔 叫到號時這個頁面會響鈴提醒</p>
      {push === "on" ? (
        <p className="mt-1 text-emerald-700" data-testid="push-on">
          ✓ 背景提醒已開啟：離開此頁也會收到通知
        </p>
      ) : (
        <p className="mt-1 text-slate-700" data-testid="keep-open">
          請保持此頁開啟、不要鎖定螢幕。
        </p>
      )}
      {push === "pending" && !iosSafari && <p className="mt-1 text-sm text-slate-500">正在開啟背景提醒…</p>}
      {push === "denied" && (
        <p className="mt-1 text-sm text-slate-500" data-testid="push-denied">
          通知權限已關閉，無法在背景提醒。
        </p>
      )}
      {canPush && (push === "off" || push === "unsupported") && !iosSafari && (
        <button className="mt-3 min-h-12 w-full rounded-xl bg-brand text-base font-bold text-white" onClick={onEnable} data-testid="enable-push">
          開啟背景提醒
        </button>
      )}
      {iosSafari && saved.push?.publicKey && <IosGuide saved={saved} />}
      {conn !== "open" && conn !== "closed" && <p className="mt-2 text-sm text-amber-700">連線中…</p>}
    </section>
  );
}

function IosGuide({ saved }: { saved: Saved }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!code) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [code]);
  const expired = !!code && code.expiresAt <= now;

  async function make() {
    setErr(false);
    try {
      setCode(await api<{ code: string; expiresAt: number }>(`/api/tickets/${saved.ticketId}/transfer`, { method: "POST", token: saved.token }));
      setNow(Date.now());
    } catch {
      setErr(true);
    }
  }

  return (
    <div className="mt-3 rounded-xl bg-slate-50 p-3" data-testid="ios-guide">
      <p className="font-bold">iPhone 要在背景收到提醒：</p>
      <ol className="mt-1 list-decimal pl-6 text-base text-slate-700">
        <li>
          點 Safari 下方的「分享」<span aria-hidden> ⬆︎</span>
        </li>
        <li>選「加入主畫面」</li>
        <li>從主畫面開啟「取號」</li>
        <li>輸入下方的轉交碼</li>
      </ol>
      {code && !expired ? (
        <div className="mt-3 text-center" data-testid="xfer">
          <p className="text-sm text-slate-500">轉交碼（10 分鐘內有效）</p>
          <p className="text-4xl font-black tracking-[0.2em] text-brand tabular-nums" data-testid="xfer-code">
            {code.code.slice(0, 3)} {code.code.slice(3)}
          </p>
          <p className="text-sm text-slate-500 tabular-nums">剩 {Math.max(0, Math.ceil((code.expiresAt - now) / 60_000))} 分鐘</p>
        </div>
      ) : (
        <button className="mt-3 min-h-12 w-full rounded-xl bg-white text-base font-bold text-brand ring-1 ring-brand/40" onClick={() => void make()} data-testid="show-xfer">
          {expired ? "轉交碼已過期，重新產生" : "顯示轉交碼"}
        </button>
      )}
      {err && <p className="mt-2 text-sm text-red-600" role="alert">無法產生轉交碼，請稍後再試。</p>}
    </div>
  );
}

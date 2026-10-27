import { useEffect, useState } from "react";
import { isOpenAt, type PublicTicket } from "@qcs/shared";
import { decodeJwt, store } from "./lib/env";
import { useDisplay } from "./useDisplay";
import { QrPanel } from "./components/QrPanel";
import { AdArea } from "./components/AdArea";
import { PairScreen } from "./Pair";

const TOKEN_KEY = "qcs.display.token";

function readToken(): string | null {
  const q = new URLSearchParams(location.search).get("token");
  if (q) {
    store.set(TOKEN_KEY, q);
    history.replaceState(null, "", location.pathname);
    return q;
  }
  return store.get(TOKEN_KEY);
}

export function App() {
  const [token, setToken] = useState(readToken);
  const claims = token ? decodeJwt(token) : null;
  if (!token || !claims?.store_id || claims.role !== "display")
    return (
      <PairScreen
        onPaired={(t) => {
          store.set(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  return (
    <Board
      key={token}
      token={token}
      storeId={claims.store_id}
      onRevoked={() => {
        store.del(TOKEN_KEY);
        setToken(null);
      }}
    />
  );
}

function useClock(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(iv);
  }, [offset]);
  return now;
}

function counterLabel(t: PublicTicket | null) {
  return t?.counterNo ? `請到 ${t.counterNo} 號櫃台` : "請到櫃台";
}

function Board({ token, storeId, onRevoked }: { token: string; storeId: string; onRevoked: () => void }) {
  const { state, conn, gateView, incomplete, ads, adsVersion } = useDisplay(token, storeId, onRevoked);
  const now = useClock(state.serverOffset);
  const s = state.store;
  const tz = s?.timezone ?? "Asia/Taipei";
  const open = s ? isOpenAt(now, s.businessHours, tz) : true;
  const time = new Intl.DateTimeFormat("zh-TW", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const services = s?.services ?? [];
  const cur = state.current;
  const recent = state.recent.filter((r) => r.id !== cur?.id).slice(0, 3);
  const suspended = !!state.suspended || conn === "suspended";
  const qrPaused = suspended || !open;

  if (suspended) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-[2vh] bg-slate-900 text-center text-white" data-testid="suspended">
        <h1 className="text-[6vh] font-black">服務暫停</h1>
        <p className="text-[2.4vh] text-white/70">{state.suspended === "expired" ? "門店服務已到期，請洽平台管理員" : "門店服務暫停中"}</p>
        <QrPanel storeId={storeId} storeCode={s?.code ?? ""} keyB64={null} baseUrl={null} serverOffset={state.serverOffset} paused />
      </main>
    );
  }

  return (
    <main className="grid h-full grid-rows-[4.2vh_26vh_37.5vh_1fr] overflow-hidden bg-brand text-white" data-testid="board">
      {/* 頂欄 */}
      <header className="flex items-center justify-between gap-[2vw] bg-black/30 px-[3vw]">
        <div className="flex min-w-0 items-center gap-[1.5vw]">
          {s?.logoUrl ? <img src={s.logoUrl} alt="" className="h-[3vh] w-auto" /> : <span className="h-[2.6vh] w-[2.6vh] shrink-0 rounded-full bg-accent" aria-hidden />}
          <h1 className="truncate text-[2.3vh] font-bold">{s?.name ?? "　"}</h1>
        </div>
        <div className="flex items-center gap-[2vw]">
          {conn !== "open" && (
            <span className="rounded-full bg-amber-500/90 px-[1.5vw] py-[0.3vh] text-[1.5vh] font-bold text-black" data-testid="conn-badge">
              連線中…
            </span>
          )}
          {incomplete && <span className="text-[1.4vh] text-white/70">語音素材不完整</span>}
          <time className="text-[2.3vh] font-bold tabular-nums">{time}</time>
        </div>
      </header>

      {/* 目前叫號 */}
      <section className="flex flex-col items-center justify-center gap-[1vh] px-[3vw]" aria-live="polite" data-testid="call-panel">
        {open ? (
          <>
            <p className="text-[2.6vh] font-bold tracking-[0.4em] text-white/80">目前叫號</p>
            {!cur && <p className="text-[6vh] font-black text-white/40" data-testid="no-call">等待叫號</p>}
            <p
              key={state.flashKey}
              hidden={!cur}
              className={`text-[min(24vw,13.5vh)] leading-none font-black tracking-[0.06em] text-accent tabular-nums ${state.flashKey ? "animate-[qcs-flash_0.6s_ease-in-out_3]" : ""}`}
              data-testid="current-number"
            >
              {cur?.number ?? ""}
            </p>
            <p className={`font-bold ${cur ? "text-[4.2vh]" : "text-[3vh] text-white/80"}`} data-testid="current-counter">
              {cur ? counterLabel(cur) : "請掃描右下角 QR Code 取號"}
            </p>
          </>
        ) : (
          <>
            <p className="text-[7vh] font-black">休息中</p>
            <p className="text-[2.4vh] text-white/80">{hoursText(s?.businessHours ?? [])}</p>
          </>
        )}
      </section>

      {/* 廣告（不與 QR 區重疊：版面排除，不是疊上去） */}
      <section className="overflow-hidden">
        <AdArea token={token} ads={ads} version={adsVersion} />
      </section>

      {/* 近期叫號＋等候；右側留給固定 QR */}
      <section className="flex min-h-0 min-w-0 flex-col gap-[0.8vh] overflow-hidden py-[1.4vh] pr-[calc(min(49vw,27.5vh)+4vw)] pl-[3vw]" data-testid="bottom-left">
        <h2 className="text-[2vh] font-bold text-white/70">近期叫號</h2>
        <ul className="flex flex-col gap-[0.4vh]" data-testid="recent">
          {recent.length === 0 && <li className="text-[2.4vh] text-white/50">尚無</li>}
          {recent.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-[1vw] border-b border-white/10 pb-[0.4vh]">
              <span className="text-[3vh] leading-tight font-black tabular-nums">{r.number}</span>
              <span className="text-[2vh] whitespace-nowrap text-white/80">{r.counterNo ? `${r.counterNo} 號櫃台` : "櫃台"}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto shrink-0 rounded-[1vw] bg-white/10 px-[2vw] py-[0.8vh]" data-testid="waiting">
          <p className="text-[1.7vh] text-white/70">等候人數</p>
          <p className="flex flex-wrap gap-x-[3vw] text-[2.6vh] leading-snug font-bold tabular-nums">
            {services.map((sv) => (
              <span key={sv.id} className="whitespace-nowrap">
                {sv.prefix} {sv.name} <span className="text-accent">{state.waiting[sv.id] ?? 0}</span>
              </span>
            ))}
          </p>
        </div>
      </section>

      <QrPanel storeId={storeId} storeCode={s?.code ?? ""} keyB64={state.qr?.keyB64 ?? null} baseUrl={state.qr?.baseUrl ?? null} serverOffset={state.serverOffset} paused={qrPaused} />

      {gateView.prompt && (
        // 全螢幕接收點擊／按鍵，但不遮暗：號碼與 QR 照常可見（05-apps §1）；提示卡放在廣告區
        <div role="alertdialog" aria-label="啟用聲音" data-testid="unlock-overlay" data-alert={gateView.alert ? "1" : "0"} className="fixed inset-0 z-40 cursor-pointer">
          <div
            className={`absolute top-[34vh] right-[5vw] left-[5vw] rounded-[2vw] border-[0.8vw] px-[5vw] py-[3vh] text-center shadow-2xl ${gateView.alert ? "border-red-300 bg-red-700 animate-[qcs-border_1s_ease-in-out_infinite]" : "border-accent bg-slate-950 animate-[qcs-border_1.6s_ease-in-out_infinite]"}`}
            data-testid="unlock-card"
          >
            <p className="text-[3.4vh] font-black text-white">{gateView.alert ? "有新叫號，但目前無法出聲" : "尚未啟用聲音"}</p>
            <p className="mt-[1.2vh] text-[2.4vh] leading-relaxed text-white">
              請按遙控器 OK 鍵、鍵盤任一鍵，
              <br />
              或點一下畫面，以啟用聲音
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function hoursText(hours: { dow: number; open: string; close: string }[]): string {
  if (!hours.length) return "";
  const today = hours.find((h) => h.dow === new Date().getDay());
  return today ? `今日營業時間 ${today.open}–${today.close}` : "今日公休";
}

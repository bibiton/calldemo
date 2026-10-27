/** 人員手機配對（06-auth §3）：手機顯示 6 位配對碼，店長在門店後台輸入後，這支手機就綁定該店。 */
import { useEffect, useState } from "react";
import { API_BASE } from "./lib/env";

interface Pairing {
  code: string;
  pollSecret: string;
  expiresAt: number;
}

export function StaffPair({ onPaired, notice }: { onPaired: (token: string) => void; notice?: string | null }) {
  const [p, setP] = useState<Pairing | null>(null);
  const [err, setErr] = useState(false);
  const [n, setN] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    setErr(false);
    fetch(`${API_BASE}/api/staff/pair/start`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: Pairing) => alive && setP(x))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [n]);

  useEffect(() => {
    if (!p) return;
    let alive = true;
    const poll = setInterval(async () => {
      if (Date.now() > p.expiresAt) {
        clearInterval(poll);
        setN((k) => k + 1);
        return;
      }
      try {
        const r = await fetch(`${API_BASE}/api/staff/pair/status?code=${p.code}&secret=${encodeURIComponent(p.pollSecret)}`);
        if (!alive) return;
        if (r.status === 404) {
          clearInterval(poll);
          setN((k) => k + 1);
          return;
        }
        const b = await r.json();
        if (b.status === "paired" && b.token) {
          clearInterval(poll);
          onPaired(b.token);
        }
      } catch {
        /* 斷網：下次再試 */
      }
    }, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [p, onPaired]);

  const left = p ? Math.min(600, Math.max(0, Math.ceil((p.expiresAt - now) / 1000))) : 0;
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col bg-white" data-testid="staff-pair">
      <header className="bg-brand px-4 py-4 text-white">
        <h1 className="text-xl font-bold">綁定這支手機</h1>
      </header>
      <section className="flex flex-1 flex-col items-center gap-4 p-6 text-center">
        {notice && (
          <p className="w-full rounded-xl bg-amber-50 p-3 text-base text-amber-900" role="status">
            {notice}
          </p>
        )}
        <p className="text-base leading-relaxed text-slate-600">請店長開啟「門店後台 → 設定 → 裝置」，輸入下方配對碼。完成後這支手機就能用來叫號。</p>
        {p ? (
          <>
            <p className="rounded-2xl bg-slate-100 px-6 py-4 text-5xl font-black tracking-[0.15em] text-brand tabular-nums" data-testid="staff-pair-code">
              {p.code.slice(0, 3)} {p.code.slice(3)}
            </p>
            <p className="text-base text-slate-500 tabular-nums">
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 後自動更新 · 等待店長確認中…
            </p>
          </>
        ) : err ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-base font-bold text-red-700" role="alert">
              無法連線，請檢查網路。
            </p>
            <button className="min-h-12 rounded-xl bg-brand px-6 text-base font-bold text-white" onClick={() => setN((k) => k + 1)}>
              重試
            </button>
          </div>
        ) : (
          <p className="text-base text-slate-500">產生配對碼中…</p>
        )}
      </section>
    </main>
  );
}

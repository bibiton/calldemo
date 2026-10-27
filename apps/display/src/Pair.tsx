/**
 * 面板配對畫面（06-auth §3、ADR-027）：面板只「顯示」配對碼，店長在門店後台輸入；全程不需要觸控或鍵盤。
 * 輪詢 /api/display/pair/status 每 3 秒、最多 10 分鐘（全系統唯一允許的輪詢，每台面板一生一次）；過期自動換新碼。
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { API_BASE, STORE_BASE } from "./lib/env";

interface Pairing {
  code: string;
  pollSecret: string;
  expiresAt: number;
}

function Qr({ text }: { text: string }) {
  const q = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = q.modules.size;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" className="block h-full w-full" role="img" aria-label="配對 QR Code">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function PairScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const [p, setP] = useState<Pairing | null>(null);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(false);
    fetch(`${API_BASE}/api/display/pair/start`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: Pairing) => alive && setP(x))
      .catch(() => {
        if (!alive) return;
        setErr(true);
        setTimeout(() => alive && setN((k) => k + 1), 10_000); // 網路恢復後自動重試
      });
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
        setP(null);
        setN((k) => k + 1);
        return;
      }
      try {
        const r = await fetch(`${API_BASE}/api/display/pair/status?code=${p.code}&secret=${encodeURIComponent(p.pollSecret)}`);
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

  const left = p ? Math.max(0, Math.ceil((p.expiresAt - now) / 1000)) : 0;
  return (
    <main className="flex h-full flex-col items-center justify-center gap-[3vh] bg-brand px-[6vw] text-center text-white" data-testid="pair-screen">
      <h1 className="text-[4.2vh] font-black">叫號面板配對</h1>
      <p className="max-w-[86vw] text-[2.4vh] leading-relaxed text-white/85">
        請店長用手機開啟「門店後台 → 設定 → 裝置」，輸入下方配對碼，
        <br />
        或直接用手機掃描 QR Code。
      </p>
      {p ? (
        <>
          <p className="rounded-[2vw] bg-white px-[5vw] py-[2vh] text-[11vh] leading-none font-black tracking-[0.12em] text-brand tabular-nums" data-testid="pair-code">
            {p.code.slice(0, 3)} {p.code.slice(3)}
          </p>
          <div className="h-[24vh] w-[24vh] rounded-[1.5vw] bg-white p-[1vh]" data-testid="pair-qr">
            <Qr text={`${STORE_BASE}/pair?code=${p.code}`} />
          </div>
          <p className="text-[2.2vh] text-white/80 tabular-nums">
            配對碼 {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 後自動更新 · 等待店長確認中…
          </p>
        </>
      ) : err ? (
        <p className="rounded-[1vw] bg-amber-400 px-[3vw] py-[1.5vh] text-[2.6vh] font-bold text-black" role="alert">
          無法連線，10 秒後自動重試…
        </p>
      ) : (
        <p className="text-[2.6vh] text-white/80">產生配對碼中…</p>
      )}
    </main>
  );
}

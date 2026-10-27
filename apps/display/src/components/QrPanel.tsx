import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { b64decode, buildQrUrl, computeQrToken, qrWindow, QR_WINDOW_MS } from "@qcs/shared";

const QUIET = 4; // 四周留白 ≥ 4 模組（05-apps §1）

/** 以 SVG 畫 QR（糾錯 M、模組大、黑白高對比）。 */
function QrSvg({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const q = QRCode.create(text, { errorCorrectionLevel: "M" });
    const n = q.modules.size;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(x, y)) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    return { size: n + QUIET * 2, path: d, version: q.version };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="block h-full w-full" role="img" aria-label="取號 QR Code">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * 動態 QR（ADR-012）：面板以 storeKey 自算 HMAC token，120 秒一換；切換前 5 秒預先算好，不閃白。
 * DO 與 Worker 都不參與。
 */
export function QrPanel(props: {
  storeId: string;
  storeCode: string;
  keyB64: string | null;
  baseUrl: string | null;
  serverOffset: number;
  paused: boolean;
}) {
  const { storeId, storeCode, keyB64, baseUrl, serverOffset, paused } = props;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!keyB64 || !baseUrl || paused) {
      setUrl(null);
      return;
    }
    const key = b64decode(keyB64);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const urlFor = async (w: number) => buildQrUrl(baseUrl, storeCode, w, await computeQrToken(key, storeId, w));
    const tick = async () => {
      const now = Date.now() + serverOffset;
      const w = qrWindow(now);
      const cur = await urlFor(w);
      if (alive) setUrl(cur);
      const msToNext = (w + 1) * QR_WINDOW_MS - now;
      timer = setTimeout(async () => {
        const next = await urlFor(w + 1); // 切換前 5 秒預算
        const wait = (w + 1) * QR_WINDOW_MS - (Date.now() + serverOffset);
        timer = setTimeout(() => {
          if (alive) setUrl(next);
          void tick();
        }, Math.max(0, wait));
      }, Math.max(0, msToNext - 5_000));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [storeId, storeCode, keyB64, baseUrl, serverOffset, paused]);

  return (
    <section
      aria-label="掃碼取號"
      className="fixed top-[68.3vh] right-[2vw] z-50 flex flex-col items-center gap-[0.6vh]"
      data-testid="qr-panel"
      data-qr-url={url ?? ""}
    >
      <div className="aspect-square w-[min(49vw,27.5vh)] overflow-hidden rounded-[1.2vw] bg-white shadow-2xl ring-4 ring-white">
        {url ? (
          <QrSvg text={url} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-[1vh] bg-slate-100 text-center text-slate-700">
            <span className="text-[4.4vh] font-black">暫停取號</span>
            <span className="text-[1.9vh]">{paused ? "目前不開放取號" : "準備中…"}</span>
          </div>
        )}
      </div>
      <p className="text-[2.6vh] leading-none font-black tracking-[0.3em] text-white">掃碼取號</p>
    </section>
  );
}

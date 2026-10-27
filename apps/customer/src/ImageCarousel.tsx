/**
 * 顧客手機圖片輪播（ADR-048）：只有圖片（不播影片，省顧客流量）、lazy 載入、不阻塞取號；
 * 讀取失敗的圖直接移除（不出現破圖），全部失敗就整塊不顯示。叫號全螢幕提醒在更上層（z-50）蓋過。
 */
import { useEffect, useState } from "react";

const INTERVAL_MS = 5000;

export function ImageCarousel({ images, testId = "carousel" }: { images: string[]; testId?: string }) {
  const [bad, setBad] = useState<string[]>([]);
  const [i, setI] = useState(0);
  const list = images.filter((u) => !bad.includes(u));
  const n = list.length;
  useEffect(() => {
    if (n < 2) return;
    const h = setInterval(() => {
      if (document.visibilityState === "visible") setI((x) => (x + 1) % n);
    }, INTERVAL_MS);
    return () => clearInterval(h);
  }, [n]);
  if (!n) return null;
  const cur = i % n;
  return (
    <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200" aria-label="門店資訊" data-testid={testId}>
      <div className="relative aspect-[3/2] w-full bg-slate-100">
        {list.map((u, k) => (
          <img
            key={u}
            src={u}
            alt=""
            loading="lazy"
            decoding="async"
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-500 motion-reduce:transition-none ${k === cur ? "opacity-100" : "opacity-0"}`}
            onError={() => setBad((b) => [...b, u])}
          />
        ))}
      </div>
      {n > 1 && (
        <div className="flex justify-center gap-1.5 py-2" aria-hidden>
          {list.map((u, k) => (
            <span key={u} className={`h-1.5 rounded-full transition-all ${k === cur ? "w-5 bg-brand" : "w-1.5 bg-slate-300"}`} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 取號表單頁的門店主視覺：一張、矮版（不把表單推出首屏；送出鈕固定在底部）。 */
export function Hero({ src }: { src?: string }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) return null;
  return (
    <div className="-mt-1 mb-4 h-[18vh] max-h-40 min-h-20 overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200" data-testid="hero">
      <img src={src} alt="" decoding="async" className="h-full w-full object-contain" onError={() => setOk(false)} />
    </div>
  );
}

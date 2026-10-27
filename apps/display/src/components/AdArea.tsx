import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/env";
import type { AdController } from "../ads/ad-controller";

export interface AdItem {
  assetId: string;
  url: string;
  kind: "image" | "video";
  durationMs: number | null;
  activeFrom: string | null;
  activeTo: string | null;
  dows: number[];
  startDate: string | null;
  endDate: string | null;
}

const DEFAULT_IMAGE_MS = 8_000;

/** 依時段／星期／日期區間過濾（門店時區以面板本地時間近似；M3 會改用門店時區）。 */
export function activeAt(it: AdItem, d: Date): boolean {
  const ymd = d.toISOString().slice(0, 10);
  const hm = d.toTimeString().slice(0, 5);
  if (!it.dows.includes(d.getDay())) return false;
  if (it.startDate && ymd < it.startDate) return false;
  if (it.endDate && ymd > it.endDate) return false;
  if (it.activeFrom && hm < it.activeFrom) return false;
  if (it.activeTo && hm >= it.activeTo) return false;
  return true;
}

/**
 * 廣告輪播（ADR-016）。版面固定比例 3:2（1080×720，ADR-028）；素材比例不符時 contain＋模糊底，不裁切。
 * 叫號時由 AdController 靜音＋暫停（T15）。
 */
export function AdArea({ token, ads, version = 0 }: { token: string; ads: AdController; version?: number }) {
  const [items, setItems] = useState<AdItem[]>([]);
  const [idx, setIdx] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/display/ads/manifest`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((m) => {
        if (!alive) return;
        const list = (m.items ?? []) as AdItem[];
        setItems(list);
        // 版本更新：通知 Service Worker 刪掉不再使用的素材（05-apps §1）
        navigator.serviceWorker?.controller?.postMessage({ t: "ads-keep", urls: list.map((x) => new URL(x.url, location.href).href) });
      })
      .catch(() => {}); // 斷網：保留目前清單繼續播（快取中的素材照播）
    return () => {
      alive = false;
    };
  }, [token, version]);

  const list = items.filter((it) => activeAt(it, new Date()));
  const cur = list.length ? list[idx % list.length] : null;
  const next = () => setIdx((i) => i + 1);

  useEffect(() => {
    if (!cur) return;
    if (cur.kind === "image") ads.timer.start(cur.durationMs ?? DEFAULT_IMAGE_MS, next);
    return () => ads.timer.clear();
  }, [cur?.assetId, idx, ads]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-brand-600 text-[2.2vh] text-white/60" data-testid="ad-area">
        廣告區
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black" data-testid="ad-area" data-ad-kind={cur.kind} data-ad-id={cur.assetId}>
      {cur.kind === "image" ? (
        <>
          <img src={cur.url} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />
          <img key={cur.assetId + idx} src={cur.url} alt="廣告" className="relative h-full w-full object-contain" />
        </>
      ) : (
        <video
          key={cur.assetId + idx}
          ref={(el) => {
            videoRef.current = el;
            ads.attachVideo(el);
          }}
          src={cur.url}
          className="h-full w-full object-contain"
          data-testid="ad-video"
          autoPlay
          muted
          playsInline
          preload="auto"
          onPlay={(e) => ads.isHeld && e.currentTarget.pause()}
          onEnded={next}
          onError={next}
        />
      )}
    </div>
  );
}

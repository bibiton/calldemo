/**
 * 小圖表（單一序列、單一品牌色，不需圖例；數值以文字標示、可點選查看單日數值）。
 * 30 日趨勢用 Spark；每店用量頁的每日長條用 DayBars（下方另有每日清單＝表格檢視）。
 */
import { useState } from "react";

export function Spark({ values, label, testId }: { values: number[]; label: string; testId?: string }) {
  const w = 120;
  const h = 32;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * w : w / 2, h - 2 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-28 shrink-0 overflow-visible" role="img" aria-label={`${label}：30 日共 ${total}，單日最多 ${max === 1 && total === 0 ? 0 : max}`} data-testid={testId}>
      <line x1="0" x2={w} y1={h - 1} y2={h - 1} className="stroke-slate-200" strokeWidth="1" />
      {total > 0 && <polyline points={`0,${h - 1} ${line} ${w},${h - 1}`} className="fill-brand/10 stroke-none" />}
      <polyline points={line} fill="none" className="stroke-brand" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function DayBars({ days, value, format, label }: { days: { date: string }[]; value: (d: any) => number; format: (n: number) => string; label: string }) {
  const [sel, setSel] = useState<number | null>(null);
  const vals = days.map(value);
  const max = Math.max(...vals, 0);
  const i = sel ?? vals.length - 1;
  const n = days.length;
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setSel(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
  };
  return (
    <figure className="flex flex-col gap-2" data-testid="day-bars">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums" aria-live="polite">
          {days[i]?.date.slice(5).replace("-", "/")}：<b className="text-slate-900">{format(vals[i] ?? 0)}</b>
        </span>
      </figcaption>
      {/* 整塊圖表一個觸控區（長條太窄不能各自當按鈕）；手指滑過即顯示該日數值 */}
      <div
        className="flex h-28 touch-pan-y items-end gap-[2px]"
        role="img"
        aria-label={`${label}，最近 ${n} 天，最多 ${format(max)}（每日數值見下方清單）`}
        onPointerDown={pick}
        onPointerMove={(e) => e.buttons && pick(e)}
      >
        {days.map((d, k) => (
          <span key={d.date} className="flex h-full flex-1 items-end">
            <span
              className={`w-full rounded-t-[4px] ${k === i ? "bg-accent" : "bg-brand"} ${vals[k] === 0 ? "opacity-20" : ""}`}
              style={{ height: max > 0 ? `${Math.max(2, (vals[k] / max) * 100)}%` : "2px" }}
            />
          </span>
        ))}
      </div>
      <div className="flex justify-between text-xs text-slate-500 tabular-nums" aria-hidden>
        <span>{days[0]?.date.slice(5).replace("-", "/")}</span>
        <span>{days.at(-1)?.date.slice(5).replace("-", "/")}</span>
      </div>
    </figure>
  );
}

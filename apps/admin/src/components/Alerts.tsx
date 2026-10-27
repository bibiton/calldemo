import type { Alert } from "../lib/types";

/** 異常警示：紅＝需要處理、黃＝注意；圖示＋文字，不只靠顏色。 */
export function AlertList({ alerts, compact }: { alerts: Alert[]; compact?: boolean }) {
  if (!alerts.length) return null;
  return (
    <ul className={`flex flex-col ${compact ? "gap-1" : "gap-2"}`} data-testid="alerts">
      {alerts.map((a, i) => (
        <li
          key={i}
          className={`flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-bold ${a.level === "red" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}
          data-kind={a.kind}
        >
          <span aria-hidden>{a.level === "red" ? "⛔" : "⚠"}</span>
          <span className="min-w-0 break-words">{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

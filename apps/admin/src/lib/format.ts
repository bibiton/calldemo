/** 數字格式（zh-TW）：金額 USD、容量 MB／GB、日期。 */
const nf = new Intl.NumberFormat("zh-TW");

export const num = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));

/** 金額：≥ $1 兩位小數；< $1 三位有效（每店每月常是幾分錢）；0 → $0。 */
export function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  if (Math.abs(n) >= 0.001) return `$${n.toFixed(3)}`;
  return "< $0.001";
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const mb = n / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  if (n === 0) return "0 MB";
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const mbOf = (n: number) => Math.round(n / 1048576);

export const date = (ms: number | null | undefined) => (ms == null ? "—" : new Date(ms).toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }));
export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 'YYYY-MM-DD'（本地日期）。到期日欄位用。 */
export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** 到期日：選定日期當天 23:59:59.999（瀏覽器時區＝平台人員所在地，台灣）。 */
export const endOfDay = (s: string) => new Date(`${s}T23:59:59.999`).getTime();

export const monthLabel = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`;
export function shiftMonth(m: string, d: number): string {
  const [y, mo] = m.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1 + d, 1));
  return t.toISOString().slice(0, 7);
}

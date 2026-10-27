import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { bytes, dateTime } from "../lib/format";
import { ACTION_TEXT, ACTOR_TEXT, LINE_TEXT } from "../lib/types";
import { Button, Empty, ErrorBox, inputCls, Loading, Page, errText } from "../ui";

interface Item {
  id: string;
  at: number;
  actorType: string;
  actorId: string;
  storeId: string | null;
  storeName: string | null;
  storeCode: string | null;
  action: string;
  target: string | null;
  detail: any;
}

const GROUPS = [
  ["", "全部動作"],
  ["store.*", "門店"],
  ["user.*", "帳號"],
  ["device.*", "裝置"],
  ["pii.reveal", "查看完整手機"],
  ["billing.input", "帳單"],
  ["brand.*", "品牌"],
] as const;

const KEY_TEXT: Record<string, string> = {
  code: "門店碼",
  name: "名稱",
  timezone: "時區",
  brandId: "品牌",
  maxDevices: "面板上限",
  maxStaff: "人員上限",
  adQuotaBytes: "廣告容量",
  email: "帳號",
  role: "角色",
  kind: "類型",
  prefix: "字首",
};
const VALUE_TEXT: Record<string, string> = { store_admin: "店長", staff: "人員", display: "叫號面板", staff_device: "人員手機" };
const FEATURE_TEXT: Record<string, string> = { push: "背景推播", ads: "面板廣告", voice: "叫號語音", showMaskedName: "遮罩姓名", internal: "內部測試" };
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("zh-TW") : "不到期");

/** detail 摘要：欄位轉中文（稽核本來就不含個資）。 */
function summary(a: Item): string | null {
  const d = a.detail;
  if (!d || typeof d !== "object") return null;
  if (a.action === "store.extend") return `到期日 ${day(d.from)} → ${day(d.to)}`;
  if (a.action === "billing.input")
    return Object.entries(d)
      .map(([k, v]) => `${LINE_TEXT[k]?.label ?? k} ${v == null ? "清除" : `$${Number(v).toFixed(2)}`}`)
      .join("、");
  const parts = Object.entries(d)
    .filter(([k, v]) => v !== null && typeof v !== "object" && KEY_TEXT[k])
    .map(([k, v]) => `${KEY_TEXT[k]} ${k === "adQuotaBytes" ? bytes(Number(v)) : (VALUE_TEXT[String(v)] ?? v)}`);
  if (d.features) parts.push(Object.entries(d.features).map(([k, v]) => `${FEATURE_TEXT[k] ?? k}${v ? "開" : "關"}`).join("、"));
  return parts.length ? parts.join(" · ") : null;
}

export function Audit() {
  const { query } = useRoute();
  const storeId = query.get("storeId");
  const storeName = query.get("name");
  const action = query.get("action") ?? "";
  const [items, setItems] = useState<Item[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = (before?: string) =>
    new URLSearchParams({ limit: "30", ...(storeId ? { storeId } : {}), ...(action ? { action } : {}), ...(before ? { before } : {}) }).toString();

  async function load(before?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ items: Item[]; next: string | null }>(`/api/admin/audit?${qs(before)}`);
      setItems((cur) => (before ? [...(cur ?? []), ...r.items] : r.items));
      setNext(r.next);
    } catch (e) {
      setError(errText(e, "讀取失敗，請稍後再試。"));
    }
    setBusy(false);
  }
  useEffect(() => {
    setItems(null);
    void load();
  }, [storeId, action]); // eslint-disable-line react-hooks/exhaustive-deps

  const setAction = (v: string) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set("action", v);
    else p.delete("action");
    navigate(`/audit?${p}`, true);
  };

  return (
    <Page title="稽核紀錄" back={storeId ? `/stores/${encodeURIComponent(storeId)}` : undefined} testId="audit">
      {storeId && (
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-1 ring-1 ring-slate-200">
          <span className="min-w-0 flex-1 truncate text-base">
            門店：<b>{storeName ?? storeId}</b>
          </span>
          <button className="min-h-11 shrink-0 px-2 text-base font-bold text-brand underline" onClick={() => navigate(`/audit${action ? `?action=${action}` : ""}`, true)}>
            看全部門店
          </button>
        </div>
      )}
      <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value)} aria-label="篩選動作" data-testid="audit-action">
        {GROUPS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {error && <ErrorBox text={error} onRetry={() => load()} />}
      {!items && !error && <Loading />}
      {items && items.length === 0 && <Empty title="沒有紀錄" text="換個篩選條件看看。" />}
      {items && items.length > 0 && (
        <ol className="flex flex-col gap-2" data-testid="audit-list">
          {items.map((a) => {
            const sum = summary(a);
            return (
              <li key={a.id} className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200" data-testid="audit-item">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 text-base font-bold">{ACTION_TEXT[a.action] ?? a.action}</p>
                  <time className="shrink-0 text-sm text-slate-500 tabular-nums">{dateTime(a.at)}</time>
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{a.storeName ? `${a.storeName}（${a.storeCode}）` : "全平台"}</p>
                <p className="text-sm break-words text-slate-600">
                  {ACTOR_TEXT[a.actorType] ?? a.actorType}：{a.actorId}
                </p>
                {sum && <p className="mt-1 break-words text-sm text-slate-500">{sum}</p>}
              </li>
            );
          })}
        </ol>
      )}
      {next && (
        <Button kind="secondary" onClick={() => load(next)} disabled={busy} data-testid="audit-more">
          {busy ? "載入中…" : "載入更多"}
        </Button>
      )}
    </Page>
  );
}

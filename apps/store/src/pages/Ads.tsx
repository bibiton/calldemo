/** 廣告管理（05-apps §4）：上傳、排序、秒數、時段／星期／日期、啟停、容量用量條。 */
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { inspect, mb, upload, type Inspected } from "../lib/upload";
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, inputCls, Loading, Page, Sheet, Toggle, errText, revealError, toast, useLoad } from "../ui";

interface Item {
  itemId: string;
  assetId: string;
  kind: "image" | "video";
  name: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  videoMs: number | null;
  imageMs: number | null;
  enabled: boolean;
  /** 顯示於顧客手機（ADR-048，只限圖片） */
  showOnCustomer: boolean;
  activeFrom: string | null;
  activeTo: string | null;
  dows: number[];
  startDate: string | null;
  endDate: string | null;
  url: string;
}
interface List {
  version: number;
  usedBytes: number;
  quotaBytes: number;
  items: Item[];
}

const DOW = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function schedule(it: Item): string {
  const t = it.activeFrom || it.activeTo ? `${it.activeFrom ?? "00:00"}–${it.activeTo ?? "24:00"}` : "全天";
  const d = it.dows.length === 7 ? "每天" : WEEK.filter((x) => it.dows.includes(x)).map((x) => "週" + DOW[x]).join("、");
  const range = it.startDate || it.endDate ? ` · ${it.startDate ?? "…"}～${it.endDate ?? "…"}` : "";
  return `${t} · ${d}${range}`;
}

export function Ads() {
  const { data, error, reload, setData } = useLoad(() => api<List>("/api/store/ads"));
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pick, setPick] = useState<Inspected | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);
  const [del, setDel] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);

  const pct = data ? Math.min(100, (data.usedBytes / data.quotaBytes) * 100) : 0;
  const free = data ? data.quotaBytes - data.usedBytes : 0;

  async function onFile(f: File | undefined) {
    if (!f || !data) return;
    setPick(await inspect(f, free));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function move(i: number, dir: -1 | 1) {
    if (!data) return;
    const items = [...data.items];
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    setData({ ...data, items });
    try {
      await api("/api/store/ads/order", { method: "POST", json: { itemIds: items.map((x) => x.itemId) } });
    } catch (e) {
      toast(errText(e), "err");
      reload();
    }
  }

  async function toggle(it: Item, enabled: boolean) {
    try {
      await api(`/api/store/ads/items/${it.itemId}`, { method: "PUT", json: { ...it, enabled } });
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  return (
    <Page
      title="廣告管理"
      testId="ads"
      footer={
        <>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="file" />
          <Button className="w-full" onClick={() => fileRef.current?.click()} disabled={!data} data-testid="upload-open">
            ＋ 上傳圖片或影片
          </Button>
        </>
      }
    >
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <Card testId="quota">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-base font-bold">容量</p>
              <p className="text-base tabular-nums" data-testid="quota-text">
                已用 {mb(data.usedBytes)} / {mb(data.quotaBytes)}
              </p>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="廣告容量用量">
              <div className={`h-full rounded-full ${pct > 90 ? "bg-red-600" : "bg-brand"}`} style={{ width: `${Math.max(pct, data.usedBytes ? 2 : 0)}%` }} />
            </div>
            <p className="mt-2 text-sm text-slate-500">建議尺寸 1080×720（3:2）。圖片 ≤ 5 MB；影片 MP4 ≤ 50 MB、≤ 120 秒。</p>
          </Card>
          {data.items.length === 0 && <Empty title="還沒有廣告" text="上傳後面板會自動輪播；沒有廣告時面板顯示門店名稱。" />}
          {data.items.length > 0 && <PhonePreview items={data.items.filter((x) => x.kind === "image" && x.enabled && x.showOnCustomer)} />}
          {data.items.map((it, i) => (
            <Card key={it.itemId} className={`!p-3 ${it.enabled ? "" : "opacity-70"}`} testId="ad-item">
              <div className="flex gap-3">
                <div className="relative aspect-[3/2] w-28 shrink-0 overflow-hidden rounded-lg bg-slate-900">
                  {it.kind === "image" ? (
                    <img src={it.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                  ) : (
                    <video src={it.url} className="h-full w-full object-contain" muted preload="metadata" playsInline />
                  )}
                  {it.kind === "video" && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs font-bold text-white">影片</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold" title={it.name ?? ""}>
                    {it.name ?? `${it.kind === "image" ? "圖片" : "影片"} ${i + 1}`}
                  </p>
                  <p className="text-sm text-slate-600 tabular-nums">
                    {it.kind === "image" ? `${Math.round((it.imageMs ?? 8000) / 1000)} 秒` : `影片 ${Math.round((it.videoMs ?? 0) / 1000)} 秒`} · {mb(it.bytes)}
                  </p>
                  <p className="text-sm text-slate-500">{schedule(it)}</p>
                  <span className="flex flex-wrap gap-1">
                    {!it.enabled && <Badge>已停用</Badge>}
                    {it.showOnCustomer && <Badge tone="green">顧客手機</Badge>}
                  </span>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <button className="flex h-11 w-11 items-center justify-center rounded-xl text-lg ring-1 ring-slate-300 disabled:opacity-30" aria-label="往前" disabled={i === 0} onClick={() => void move(i, -1)} data-testid={`up-${i}`}>
                  ↑
                </button>
                <button className="flex h-11 w-11 items-center justify-center rounded-xl text-lg ring-1 ring-slate-300 disabled:opacity-30" aria-label="往後" disabled={i === data.items.length - 1} onClick={() => void move(i, 1)} data-testid={`down-${i}`}>
                  ↓
                </button>
                <span className="flex-1" />
                <Toggle checked={it.enabled} onChange={(x) => void toggle(it, x)} label={`啟用 ${it.name ?? ""}`} testId={`enable-${i}`} />
                <Button kind="secondary" className="!min-h-11 !px-3" onClick={() => setEdit(it)} data-testid={`edit-${i}`}>
                  設定
                </Button>
                <Button kind="danger" className="!min-h-11 !px-3" onClick={() => setDel(it)} data-testid={`del-${i}`}>
                  刪除
                </Button>
              </div>
            </Card>
          ))}
        </>
      )}
      {pick && <UploadSheet it={pick} onClose={() => setPick(null)} onDone={() => { setPick(null); reload(); }} />}
      {edit && <EditSheet it={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {del && (
        <Confirm
          title="刪除這則廣告？"
          text="面板會在下次更新清單時停止播放，並釋放容量。"
          ok="刪除"
          danger
          busy={busy}
          onCancel={() => setDel(null)}
          onOk={async () => {
            setBusy(true);
            try {
              await api(`/api/store/ads/items/${del.itemId}`, { method: "DELETE" });
              toast("已刪除");
              setDel(null);
              reload();
            } catch (e) {
              toast(errText(e), "err");
            }
            setBusy(false);
          }}
        />
      )}
    </Page>
  );
}

function UploadSheet({ it, onClose, onDone }: { it: Inspected; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(it.file.name.slice(0, 80));
  const [noPreview, setNoPreview] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const blocked = it.errors.length > 0;

  async function go() {
    setErr(null);
    try {
      await upload(it, name.trim() || it.file.name, setProgress);
      toast("上傳完成，面板會自動更新");
      onDone();
    } catch (e: any) {
      setErr(e?.code === "QUOTA_EXCEEDED" ? "廣告容量不足，請先刪除不用的素材。" : errText(e, "上傳失敗，請稍後再試。"));
      setProgress(null);
    }
  }

  return (
    <Sheet
      title="上傳廣告"
      onClose={progress === null ? onClose : () => {}}
      testId="upload-sheet"
      footer={
        <Button className="w-full" onClick={() => void go()} disabled={blocked || progress !== null} data-testid="upload-go">
          {progress !== null ? `上傳中 ${Math.round(progress * 100)}%` : blocked ? "無法上傳" : "上傳"}
        </Button>
      }
    >
      <div className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-xl bg-slate-900">
        {noPreview || !it.kind || (it.errors.length > 0 && !it.width) ? (
          <span className="text-base text-white/70">無法預覽這個檔案</span>
        ) : it.kind === "image" ? (
          <img src={it.previewUrl} alt="預覽" className="h-full w-full object-contain" onError={() => setNoPreview(true)} />
        ) : (
          <video src={it.previewUrl} className="h-full w-full object-contain" muted controls playsInline onError={() => setNoPreview(true)} />
        )}
      </div>
      <p className="text-base text-slate-600 tabular-nums">
        {it.kind === "video" ? "影片" : it.kind === "image" ? "圖片" : "檔案"} · {mb(it.file.size)}
        {it.width ? ` · ${it.width}×${it.height}` : ""}
        {it.durationMs ? ` · ${Math.round(it.durationMs / 1000)} 秒` : ""}
      </p>
      {it.errors.map((e) => (
        <p key={e} className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800 ring-1 ring-red-200" role="alert" data-testid="upload-error">
          ✕ {e}
        </p>
      ))}
      {it.warnings.map((w) => (
        <p key={w} className="rounded-xl bg-amber-50 p-3 text-base text-amber-900 ring-1 ring-amber-200" data-testid="upload-warning">
          ⚠ {w}
        </p>
      ))}
      {!blocked && (
        <Field label="名稱">
          <input className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="upload-name" />
        </Field>
      )}
      {progress !== null && (
        <div className="h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="上傳進度">
          <div className="h-full bg-brand transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {err && (
        <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="sheet-error">
          {err}
        </p>
      )}
    </Sheet>
  );
}

function EditSheet({ it, onClose, onSaved }: { it: Item; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    imageMs: String(Math.round((it.imageMs ?? 8000) / 1000)),
    enabled: it.enabled,
    showOnCustomer: it.showOnCustomer,
    allDay: !it.activeFrom && !it.activeTo,
    activeFrom: it.activeFrom ?? "11:00",
    activeTo: it.activeTo ?? "14:00",
    dows: it.dows,
    startDate: it.startDate ?? "",
    endDate: it.endDate ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const secErr = it.kind === "image" && (!/^\d{1,3}$/.test(v.imageMs) || Number(v.imageMs) < 1 || Number(v.imageMs) > 600) ? "請輸入 1～600 秒" : null;
  const timeErr = !v.allDay && v.activeFrom >= v.activeTo ? "結束時間要晚於開始時間" : null;
  const dowErr = v.dows.length === 0 ? "至少選一天" : null;
  const dateErr = v.startDate && v.endDate && v.startDate > v.endDate ? "結束日期要晚於開始日期" : null;

  async function save() {
    if (secErr || timeErr || dowErr || dateErr) {
      setErr("請修正紅色欄位");
      revealError();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/store/ads/items/${it.itemId}`, {
        method: "PUT",
        json: {
          imageMs: it.kind === "image" ? Number(v.imageMs) * 1000 : null,
          enabled: v.enabled,
          ...(it.kind === "image" ? { showOnCustomer: v.showOnCustomer } : {}),
          activeFrom: v.allDay ? null : v.activeFrom,
          activeTo: v.allDay ? null : v.activeTo,
          dows: v.dows,
          startDate: v.startDate || null,
          endDate: v.endDate || null,
        },
      });
      toast("已儲存");
      onSaved();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title="播放設定" onClose={onClose} testId="edit-sheet" footer={<Button className="w-full" onClick={() => void save()} disabled={busy} data-testid="save">{busy ? "儲存中…" : "儲存"}</Button>}>
      {it.kind === "image" && (
        <Field label="停留秒數" error={secErr}>
          <input className={inputCls} inputMode="numeric" value={v.imageMs} onChange={(e) => setV({ ...v, imageMs: e.target.value.replace(/\D/g, "") })} aria-invalid={!!secErr} data-testid="seconds" />
        </Field>
      )}
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-1">
        <span className="text-base font-bold">播放</span>
        <Toggle checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="播放" />
      </div>
      {it.kind === "image" ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-1">
          <span className="min-w-0">
            <span className="block text-base font-bold">顯示於顧客手機</span>
            <span className="block text-sm text-slate-500">顧客取號頁與號碼頁輪播（依下方時段）</span>
          </span>
          <Toggle checked={v.showOnCustomer} onChange={(x) => setV({ ...v, showOnCustomer: x })} label="顯示於顧客手機" testId="show-on-customer" />
        </div>
      ) : (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">影片只在叫號面板播放，不會出現在顧客手機（節省顧客流量）。</p>
      )}
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-1">
        <span className="text-base font-bold">全天播放</span>
        <Toggle checked={v.allDay} onChange={(x) => setV({ ...v, allDay: x })} label="全天播放" testId="ad-allday" />
      </div>
      {!v.allDay && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input type="time" className={`${inputCls} !w-auto min-w-0 flex-1`} value={v.activeFrom} aria-label="開始時間" aria-invalid={!!timeErr} onChange={(e) => setV({ ...v, activeFrom: e.target.value })} data-testid="from" />
            <span className="text-slate-500">–</span>
            <input type="time" className={`${inputCls} !w-auto min-w-0 flex-1`} value={v.activeTo} aria-label="結束時間" aria-invalid={!!timeErr} onChange={(e) => setV({ ...v, activeTo: e.target.value })} data-testid="to" />
          </div>
          {timeErr && <p className="text-sm font-bold text-red-700">{timeErr}</p>}
        </div>
      )}
      <fieldset>
        <legend className="mb-2 text-base font-bold">星期</legend>
        <div className="grid grid-cols-7 gap-1">
          {WEEK.map((d) => {
            const on = v.dows.includes(d);
            return (
              <button
                key={d}
                aria-pressed={on}
                className={`min-h-11 rounded-lg text-base font-bold ${on ? "bg-brand text-white" : "bg-white text-slate-600 ring-1 ring-slate-300"}`}
                onClick={() => setV({ ...v, dows: on ? v.dows.filter((x) => x !== d) : [...v.dows, d] })}
                data-testid={`dow-${d}`}
              >
                {DOW[d]}
              </button>
            );
          })}
        </div>
        {dowErr && <p className="mt-1 text-sm font-bold text-red-700">{dowErr}</p>}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="開始日期（選填）">
          <input type="date" className={inputCls} value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} />
        </Field>
        <Field label="結束日期（選填）" error={dateErr}>
          <input type="date" className={inputCls} value={v.endDate} onChange={(e) => setV({ ...v, endDate: e.target.value })} aria-invalid={!!dateErr} />
        </Field>
      </div>
      {err && (
        <p className="rounded-xl bg-red-50 p-3 text-base font-bold text-red-800" role="alert" data-testid="sheet-error">
          {err}
        </p>
      )}
    </Sheet>
  );
}

/** 顧客手機預覽：勾選「顯示於顧客手機」且啟用中的圖片，以手機外框輪播（與顧客頁相同 3:2、5 秒）。 */
function PhonePreview({ items }: { items: Item[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (items.length < 2) return;
    const h = setInterval(() => setI((x) => (x + 1) % items.length), 5000);
    return () => clearInterval(h);
  }, [items.length]);
  return (
    <Card testId="phone-preview">
      <p className="text-base font-bold">顧客手機預覽</p>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">在圖片的「設定」開啟「顯示於顧客手機」，顧客取號頁與號碼頁就會輪播這些圖片。</p>
      ) : (
        <div className="mt-3 flex items-center gap-4">
          <div className="w-32 shrink-0 rounded-[1.25rem] bg-slate-900 p-1.5 shadow" aria-hidden>
            <div className="overflow-hidden rounded-2xl bg-[#f4f6fa]">
              <div className="h-4 bg-brand" />
              <div className="mx-2 mt-2 rounded-lg bg-white py-2 text-center text-[10px] font-black text-brand">A012</div>
              <div className="relative mx-2 my-2 aspect-[3/2] overflow-hidden rounded-md bg-slate-100">
                <img src={items[i % items.length].url} alt="" className="h-full w-full object-contain" />
              </div>
            </div>
          </div>
          <p className="min-w-0 text-sm text-slate-600">
            {items.length} 張圖片輪播中（每 5 秒）。只放圖片、不放影片；依各自的播放時段顯示。
          </p>
        </div>
      )}
    </Card>
  );
}

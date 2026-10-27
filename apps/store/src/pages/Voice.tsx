/**
 * 叫號語音設定（05-apps §4、ADR-025）：風格俏皮／標準、俏皮前綴機率、主題包／單句、叮咚、次數、音量、靜音時段、試聽。
 * 趣味穿插語音已取消（ADR-033），這裡不出現任何穿插選項。
 */
import { useEffect, useMemo, useState } from "react";
import { createPlanner } from "@qcs/shared/voice/plan";
import { normalizeVoiceSettings, type VoiceSettings } from "@qcs/shared/voice/settings";
import type { Manifest, ManifestFile } from "@qcs/shared/voice/types";
import { api } from "../lib/api";
import { AUDIO_BASE } from "../lib/env";
import { invalidateMe, useMe } from "../lib/me";
import { playSegments } from "../lib/preview";
import { Button, Card, ErrorBox, inputCls, Loading, Page, Toggle, errText, toast } from "../ui";

type Pack = { key: string; name: string; note?: string; prefixKeys: string[] };

/** manifest 的 note 是給素材維護者看的（含 venue=food、manualOnly 等術語），店長看的說明在這裡。 */
const PACK_NOTE: Record<string, string> = {
  hungry: "餐飲業限定",
  waited: "感謝耐心等候",
  anticipation: "好事要發生了",
  warm: "歡迎與感謝",
  festival: "天氣與節日，建議當季／當天再開啟",
};
const plain = (s: string) => s.replace(/[（(][^）)]*[A-Za-z=][^）)]*[）)]/g, "").trim();

export function Voice() {
  const me = useMe();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [mErr, setMErr] = useState<string | null>(null);
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${AUDIO_BASE}manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setManifest)
      .catch(() => setMErr("讀取語音素材清單失敗，請稍後再試。"));
  }, []);
  useEffect(() => {
    if (me.data && !v) setV(normalizeVoiceSettings(me.data.store.voiceSettings as Record<string, unknown>));
  }, [me.data, v]);

  const files = useMemo(() => new Map((manifest?.files ?? []).map((f) => [f.key, f])), [manifest]);
  if (me.error || mErr) return <Page title="叫號語音" back="/more"><ErrorBox text={me.error ?? mErr!} onRetry={() => location.reload()} /></Page>;
  if (!manifest || !v) return <Page title="叫號語音" back="/more"><Loading /></Page>;

  const fun = v.mode === "fun";
  const packs = (manifest.prefixPacks as Pack[]).filter((p) => p.key !== "standard");
  const lines = (p: Pack) => p.prefixKeys.map((k) => files.get(k)).filter((f): f is ManifestFile => !!f && !f.manualOnly);
  const foodOnly = (p: Pack) => lines(p).length > 0 && lines(p).every((f) => f.venue === "food");
  const effective = v.enabledPacks.length ? v.enabledPacks : packs.filter((p) => lines(p).some((f) => f.defaultEnabled)).map((p) => p.key);
  const packOn = (p: Pack) => effective.includes(p.key);
  const togglePack = (p: Pack) => setV({ ...v, enabledPacks: packOn(p) ? effective.filter((k) => k !== p.key) : [...effective, p.key] });
  const lineOn = (k: string) => !v.disabledLines.includes(k);
  const toggleLine = (k: string) => setV({ ...v, disabledLines: lineOn(k) ? [...v.disabledLines, k] : v.disabledLines.filter((x) => x !== k) });
  const chimes = manifest.files.filter((f) => f.category === "chime");

  async function play(id: string, keys: string[] | "full") {
    setPlaying(id);
    try {
      const planner = createPlanner(manifest!, v!, Math.random, AUDIO_BASE);
      const segs =
        keys === "full"
          ? planner.plan({ ticketId: "preview", number: "A023", counterNo: 2, kind: "call" }).segments
          : keys.map((k) => ({ key: k, url: AUDIO_BASE + files.get(k)!.file, gapBeforeMs: 0 }));
      await playSegments(segs, v!.volume);
    } catch {
      toast("無法播放試聽，請檢查網路或手機音量", "err");
    }
    setPlaying(null);
  }
  const PlayBtn = ({ id, keys, label }: { id: string; keys: string[] | "full"; label: string }) => (
    <button
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base text-brand active:bg-slate-200"
      aria-label={label}
      onClick={() => void play(id, keys)}
      data-testid={`play-${id}`}
    >
      {playing === id ? "■" : "▶"}
    </button>
  );

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ voiceSettings: VoiceSettings }>("/api/store/settings/voice", { method: "PUT", json: { voiceSettings: v } });
      setV(r.voiceSettings);
      toast("已儲存，面板下一次叫號即套用");
      invalidateMe();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Page
      title="叫號語音"
      back="/more"
      testId="voice"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button kind="secondary" onClick={() => void play("full", "full")} data-testid="play-full">
            {playing === "full" ? "■ 播放中" : "▶ 試聽叫號"}
          </Button>
          <Button onClick={() => void save()} disabled={busy} data-testid="save">
            {busy ? "儲存中…" : "儲存"}
          </Button>
        </div>
      }
    >
      <Card>
        <h2 className="text-lg font-bold">風格</h2>
        <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="叫號風格">
          {(["fun", "standard"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={v.mode === m}
              className={`min-h-14 rounded-xl px-3 text-base font-bold ${v.mode === m ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
              onClick={() => setV({ ...v, mode: m })}
              data-testid={`mode-${m}`}
            >
              {m === "fun" ? "俏皮" : "標準"}
              <span className="block text-sm font-normal opacity-80">{m === "fun" ? "偶爾加俏皮前綴" : "一律「來賓」"}</span>
            </button>
          ))}
        </div>
        {fun && (
          <div className="mt-4">
            <label className="flex items-baseline justify-between text-base font-bold" htmlFor="prob">
              俏皮前綴出現機率 <span className="text-2xl text-brand tabular-nums" data-testid="prob-value">{Math.round(v.funPrefixProb * 100)}%</span>
            </label>
            <input
              id="prob"
              type="range"
              min={0}
              max={100}
              step={10}
              value={Math.round(v.funPrefixProb * 100)}
              onChange={(e) => setV({ ...v, funPrefixProb: Number(e.target.value) / 100 })}
              className="mt-2 h-11 w-full accent-brand"
              data-testid="prob"
            />
            <p className="text-sm text-slate-500">其餘次數唸標準的「來賓」</p>
          </div>
        )}
      </Card>

      {fun && (
        <Card testId="packs">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold">本店是餐飲業</h2>
              <p className="text-sm text-slate-500">開啟後才會使用「餓了系」等餐飲限定前綴</p>
            </div>
            <Toggle checked={v.venue === "food"} onChange={(x) => setV({ ...v, venue: x ? "food" : "any" })} label="本店是餐飲業" testId="venue-food" />
          </div>
          <h2 className="mt-4 text-lg font-bold">主題包</h2>
          <ul className="mt-2 flex flex-col divide-y divide-slate-100">
            {packs.map((p) => {
              const ls = lines(p);
              const blocked = foodOnly(p) && v.venue !== "food";
              return (
                <li key={p.key} className="py-2" data-testid={`pack-${p.key}`}>
                  <div className="flex items-center gap-2">
                    <label className="flex min-h-12 min-w-0 flex-1 items-center gap-3">
                      <input type="checkbox" className="h-6 w-6 shrink-0 accent-brand" checked={packOn(p) && !blocked} disabled={blocked} onChange={() => togglePack(p)} data-testid={`pack-check-${p.key}`} />
                      <span className="min-w-0">
                        <span className="block text-base font-bold">
                          {p.name} <span className="font-normal text-slate-500">{ls.length} 句</span>
                        </span>
                        <span className="block text-sm text-slate-500">{blocked ? "餐飲業才會使用" : PACK_NOTE[p.key] ?? plain(p.note ?? "")}</span>
                      </span>
                    </label>
                    <PlayBtn id={`pack-${p.key}`} keys={ls.length ? [ls[Math.floor(Math.random() * ls.length)].key] : []} label={`試聽${p.name}`} />
                  </div>
                  <button className="min-h-11 pl-9 text-base text-brand" onClick={() => setOpen(open === p.key ? null : p.key)} aria-expanded={open === p.key} data-testid={`pack-open-${p.key}`}>
                    {open === p.key ? "收合 ▴" : "單句勾選 ▾"}
                  </button>
                  {open === p.key && (
                    <ul className="ml-9 flex flex-col">
                      {ls.map((f) => (
                        <li key={f.key} className="flex items-center gap-2">
                          <label className="flex min-h-12 min-w-0 flex-1 items-center gap-3">
                            <input type="checkbox" className="h-5 w-5 shrink-0 accent-brand" checked={lineOn(f.key)} disabled={!packOn(p) || blocked} onChange={() => toggleLine(f.key)} />
                            <span className="text-base leading-snug">{f.text}</span>
                          </label>
                          <PlayBtn id={f.key} keys={[f.key]} label={`試聽：${f.text}`} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-bold">叮咚與播放</h2>
        <div className="mt-3 flex items-center gap-2">
          <select className={`${inputCls} flex-1`} value={v.chime} onChange={(e) => setV({ ...v, chime: e.target.value })} aria-label="叮咚音效" data-testid="chime">
            {chimes.map((c) => (
              <option key={c.key} value={c.key}>
                {plain(c.text)}
              </option>
            ))}
          </select>
          <PlayBtn id="chime" keys={[v.chime]} label="試聽叮咚" />
        </div>
        <p className="mt-4 text-base font-bold">叫號句唸幾次</p>
        <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="叫號句唸幾次">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={v.repeat === n}
              className={`min-h-12 rounded-xl text-base font-bold ${v.repeat === n ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
              onClick={() => setV({ ...v, repeat: n })}
              data-testid={`repeat-${n}`}
            >
              {n} 次
            </button>
          ))}
        </div>
        <label className="mt-4 flex items-baseline justify-between text-base font-bold" htmlFor="vol">
          音量 <span className="text-brand tabular-nums">{Math.round(v.volume * 100)}%</span>
        </label>
        <input id="vol" type="range" min={0} max={100} step={5} value={Math.round(v.volume * 100)} onChange={(e) => setV({ ...v, volume: Number(e.target.value) / 100 })} className="mt-2 h-11 w-full accent-brand" />
      </Card>

      <Card>
        <h2 className="text-lg font-bold">靜音時段</h2>
        <p className="text-sm text-slate-500">這段時間面板照常顯示叫號，但不出聲</p>
        {v.muteRanges.length === 0 && <p className="mt-2 text-base text-slate-500">尚未設定</p>}
        {v.muteRanges.map((r, i) => (
          <div key={i} className="mt-2 flex items-center gap-2">
            <input type="time" className={`${inputCls} !w-auto min-w-0 flex-1`} value={r.from} aria-label="靜音開始" onChange={(e) => setV({ ...v, muteRanges: v.muteRanges.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
            <span className="text-slate-500">–</span>
            <input type="time" className={`${inputCls} !w-auto min-w-0 flex-1`} value={r.to} aria-label="靜音結束" onChange={(e) => setV({ ...v, muteRanges: v.muteRanges.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
            <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-slate-500 active:bg-slate-100" aria-label="刪除靜音時段" onClick={() => setV({ ...v, muteRanges: v.muteRanges.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        {v.muteRanges.length < 10 && (
          <button className="mt-2 min-h-11 text-base text-brand underline" onClick={() => setV({ ...v, muteRanges: [...v.muteRanges, { from: "12:00", to: "13:00" }] })} data-testid="add-mute">
            ＋ 新增靜音時段
          </button>
        )}
      </Card>
    </Page>
  );
}

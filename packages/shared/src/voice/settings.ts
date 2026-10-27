/**
 * 門店語音設定（stores.voice_settings，03-data-model）；缺欄位採預設。片段 id 一律用 manifest 的 key。
 * 趣味穿插語音已由業主取消（ADR-033）：舊資料若帶 `interjection` 欄位一律忽略。
 */
export interface VoiceSettings {
  volume: number;
  repeat: number;
  chime: string;
  lang: string;
  mode: "fun" | "standard";
  funPrefixProb: number;
  venue: "any" | "food";
  enabledPacks: string[];
  disabledLines: string[];
  muteRanges: { from: string; to: string }[];
}

const clamp = (x: unknown, lo: number, hi: number, d: number) => {
  const n = typeof x === "number" && Number.isFinite(x) ? x : d;
  return Math.min(hi, Math.max(lo, n));
};
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

export function normalizeVoiceSettings(raw: Record<string, any> | null | undefined): VoiceSettings {
  const r = raw ?? {};
  return {
    volume: clamp(r.volume, 0, 1, 0.8),
    repeat: Math.round(clamp(r.repeat, 1, 3, 2)),
    chime: typeof r.chime === "string" && r.chime.startsWith("chime.") ? r.chime : "chime.dingdong",
    lang: "zh-TW",
    mode: r.mode === "standard" ? "standard" : "fun",
    funPrefixProb: clamp(r.funPrefixProb, 0, 1, 0.3),
    venue: r.venue === "food" ? "food" : "any",
    enabledPacks: strs(r.enabledPacks),
    disabledLines: strs(r.disabledLines),
    muteRanges: Array.isArray(r.muteRanges)
      ? r.muteRanges.filter((m: any) => /^\d\d:\d\d$/.test(m?.from) && /^\d\d:\d\d$/.test(m?.to))
      : [],
  };
}

/** HH:MM 是否落在靜音時段（支援跨午夜）。 */
export function isMuted(s: VoiceSettings, hhmm: string): boolean {
  return s.muteRanges.some(({ from, to }) => (from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to));
}

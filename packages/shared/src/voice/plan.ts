/**
 * 依 assets/audio/manifest.json 組出叫號播放片段（05-apps §1、assets/audio/README.md）。
 * 只有「叮咚 → 前綴＋號碼＋櫃台 ×N」；趣味穿插語音已取消（ADR-033），manifest 即使有 interjection 類句子也不使用。
 */
import type { CallItem, Manifest, ManifestFile, Plan, Segment } from "./types";
import type { VoiceSettings } from "./settings";

export function parseNumber(number: string): { letters: string; n: number } | null {
  const m = /^([A-Z]{1,2})(\d+)$/.exec(number);
  return m ? { letters: m[1], n: Number(m[2]) } : null;
}

export function createPlanner(manifest: Manifest, settings: VoiceSettings, rng: () => number = Math.random, audioBase = "/audio/") {
  const byKey = new Map<string, ManifestFile>(manifest.files.map((f) => [f.key, f]));
  const g = manifest.gapsMs;
  let lastPrefix: string | null = null;

  const seg = (key: string, gapBeforeMs: number): Segment | null => {
    const f = byKey.get(key);
    return f ? { key, url: audioBase + f.file, gapBeforeMs } : null;
  };

  function prefixPool(): string[] {
    const prefixes = manifest.files.filter((f) => f.category === "prefix" && f.pack !== "standard" && !f.manualOnly);
    const picked = settings.enabledPacks.length
      ? prefixes.filter((f) => settings.enabledPacks.includes(f.pack ?? ""))
      : prefixes.filter((f) => f.defaultEnabled);
    return picked
      .filter((f) => settings.venue === "food" || f.venue !== "food")
      .filter((f) => !settings.disabledLines.includes(f.key))
      .map((f) => f.key);
  }

  function pickPrefix(): string {
    if (settings.mode === "standard" || settings.funPrefixProb <= 0) return "prefix.std";
    if (!(rng() < settings.funPrefixProb)) return "prefix.std";
    let pool = prefixPool();
    if (pool.length > 1 && lastPrefix) pool = pool.filter((k) => k !== lastPrefix);
    if (!pool.length) return "prefix.std";
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  }

  /** 依 rules 的檔名樣板組出號碼片段（號碼明細在 manifest.numbers.json，不在 files）。 */
  const fill = (tpl: string, L: string, n: number) =>
    tpl.replace("{L}", L).replace("{NNN}", String(n).padStart(3, "0")).replace("{n}", String(n));
  const raw = (key: string, file: string, gapBeforeMs: number): Segment => ({ key, url: audioBase + file, gapBeforeMs });

  /** A～F 整段為主路徑，其他字首或兩字元字首逐字母＋純號碼。null = 無法拼接。 */
  function numberSegs(number: string): Segment[] | null {
    const p = parseNumber(number);
    if (!p) return null;
    const r = manifest.rules.number;
    const [lo, hi] = r.combined.range;
    if (p.n < lo || p.n > hi) return null;
    if (p.letters.length === 1 && r.combined.letters.includes(p.letters)) {
      return [raw(`number.${p.letters}.${p.n}`, fill(r.combined.file, p.letters, p.n), g.prefixToNumber)];
    }
    const out = Array.from(p.letters).map((L, i) => raw(`letter.${L}`, fill(r.fallback.letterFile, L, p.n), i === 0 ? g.prefixToNumber : g.letterToNumber));
    out.push(raw(`number._.${p.n}`, fill(r.fallback.numberFile, "_", p.n), g.letterToNumber));
    return out;
  }

  function spoken(number: string): string {
    const p = parseNumber(number);
    return p ? `${p.letters}${p.n}號` : `${number}號`;
  }

  function plan(item: CallItem): Plan {
    const chime = seg(byKey.has(settings.chime) ? settings.chime : "chime.dingdong", 0)!;
    const nums = numberSegs(item.number);
    const counterKey =
      item.counterNo && item.counterNo >= manifest.rules.counter.range[0] && item.counterNo <= manifest.rules.counter.range[1]
        ? `counter.${item.counterNo}`
        : "phrase.desk";
    const endingText = counterKey === "phrase.desk" ? "請到櫃台辦理" : `請到${item.counterNo}號櫃台`;

    if (item.kind === "skipped") {
      const segments = nums ? [chime, seg("prefix.std", g.afterChime)!, ...nums, seg("phrase.skipped", g.numberToEnding)!] : [];
      return { item, segments, text: `來賓，${spoken(item.number)}，已經過號囉，請洽櫃台人員`, prefixKey: "prefix.std", speechOnly: !nums };
    }

    const prefixKey = pickPrefix();
    lastPrefix = prefixKey;
    const prefixText = byKey.get(prefixKey)?.text ?? "來賓";
    const text = `${prefixText}，${spoken(item.number)}，${endingText}`;
    if (!nums) return { item, segments: [], text, prefixKey, speechOnly: true };

    const segments: Segment[] = [chime];
    const isRecall = item.kind === "recall";
    if (isRecall) segments.push(seg(rng() < 0.5 ? "phrase.recall1" : "phrase.recall2", g.afterChime)!);
    for (let r = 0; r < settings.repeat; r++) {
      const gap = r > 0 ? g.betweenRepeats : isRecall ? g.recallToPrefix : g.afterChime;
      segments.push(seg(prefixKey, gap)!, ...nums, seg(counterKey, g.numberToEnding)!);
    }

    return { item, segments, text, prefixKey, speechOnly: false };
  }

  /** 解鎖確認音：只播叮咚。 */
  function chimeOnly(): Plan {
    const chime = seg(byKey.has(settings.chime) ? settings.chime : "chime.dingdong", 0)!;
    return { item: { ticketId: "_chime", number: "", counterNo: null, kind: "call" }, segments: [chime], text: "", prefixKey: "", speechOnly: false };
  }

  return { plan, prefixPool, chimeOnly };
}

export type Planner = ReturnType<typeof createPlanner>;

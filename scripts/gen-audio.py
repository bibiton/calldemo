#!/usr/bin/env python3
"""產生叫號系統的預錄語音素材（零執行成本：面板只播放檔案，不做即時 TTS）。

用法：
  python3 scripts/gen-audio.py              # 增量產生（只重做有變動的檔案）
  python3 scripts/gen-audio.py --force      # 全部重做
  python3 scripts/gen-audio.py --only prefix,chime   # 只做某些類別
  python3 scripts/gen-audio.py --demos-only # 只重組 demo

台詞與參數在 scripts/audio-lines.json。需求：ffmpeg、ffprobe、edge-tts（pipx，~/.local/bin）。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINES = ROOT / "scripts" / "audio-lines.json"
OUT = ROOT / "assets" / "audio"
CACHE = OUT / ".gen-cache.json"
PIPELINE_VERSION = 3  # 改了處理流程（裁切、編碼）就 +1，強制全部重做
EDGE_TTS = shutil.which("edge-tts") or str(Path.home() / ".local/bin/edge-tts")
CARRIER_TAIL = "，A二十三號。"  # 前綴放進載體句再切下來，語尾才會是「接下去」的語調

DIGITS = "零一二三四五六七八九"


# ---------- 數字轉中文（台灣口語） ----------
def zh_number(n: int) -> str:
    if not 1 <= n <= 999:
        raise ValueError(n)
    h, rest = divmod(n, 100)
    t, u = divmod(rest, 10)
    out = ""
    if h:
        out += ("兩" if h == 2 else DIGITS[h]) + "百"
        if rest == 0:
            return out
        if t == 0:
            return out + "零" + DIGITS[u]
        out += DIGITS[t] + "十"  # 一百一十、兩百一十三
        return out + (DIGITS[u] if u else "")
    if t:
        out += ("" if t == 1 else DIGITS[t]) + "十"
    return out + (DIGITS[u] if u else "")


# ---------- 小工具 ----------
def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def probe_duration(path: Path) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], text=True)
    return round(float(r.stdout.strip()), 3)


def tts(text: str, voice: dict, out: Path, attempts: int = 5) -> None:
    """edge-tts 偶爾回 NoAudioReceived（實測 YunJhe 特別常見），重試＋退避。"""
    for i in range(attempts):
        try:
            run([EDGE_TTS, "-v", voice["name"], f"--rate={voice['rate']}", f"--pitch={voice['pitch']}",
                 "-t", text, "--write-media", str(out)])
            if out.exists() and out.stat().st_size > 1000:
                return
        except subprocess.CalledProcessError:
            pass
        time.sleep(1.5 * (2 ** i))
    raise RuntimeError(f"edge-tts 失敗：{text}")


def silences(path: Path, db: int = -40, min_s: float = 0.08):
    r = subprocess.run(["ffmpeg", "-i", str(path), "-af", f"silencedetect=n={db}dB:d={min_s}", "-f", "null", "-"],
                       capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", r.stderr)]
    return list(zip(starts, ends + [None] * (len(starts) - len(ends))))


def encode_trimmed(src: Path, dst: Path, cfg: dict, cut_at: float | None = None) -> None:
    """去頭尾靜音、尾端淡出、轉成目標格式。cut_at：先只取前 cut_at 秒（載體句切割用）。"""
    tr, enc = cfg["trim"], cfg["encode"]
    th = f"{tr['thresholdDb']}dB"
    af = (f"silenceremove=start_periods=1:start_threshold={th}:start_silence={tr['keepLeadMs'] / 1000},"
          f"areverse,silenceremove=start_periods=1:start_threshold={th}:start_silence={tr['keepTailMs'] / 1000},"
          f"afade=t=in:d={tr['fadeOutMs'] / 1000},areverse,afade=t=in:d=0.005")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if cut_at is not None:  # 必須是輸入選項（放 -i 前）：先截斷原檔再裁靜音
        cmd += ["-t", f"{cut_at:.3f}"]
    cmd += ["-i", str(src)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    run(cmd + ["-af", af, "-ac", str(enc["channels"]), "-ar", str(enc["sampleRate"]),
               "-c:a", "libmp3lame", "-b:a", enc["bitrate"], str(dst)])


def voiced_duration(path: Path) -> float:
    """整段（含 edge-tts 前後填充）裡有聲部分的長度。"""
    sil = silences(path)
    total = probe_duration(path)
    lead = tail = 0.0
    if sil and sil[0][0] < 0.01 and sil[0][1]:
        lead = sil[0][1]
    if sil and (sil[-1][1] is None or sil[-1][1] >= total - 0.01):
        tail = total - sil[-1][0]
    return total - lead - tail, lead


# ---------- 各類片段的產生方式 ----------
def make_plain(job, cfg, tmpdir):
    raw = Path(tmpdir) / (hashlib.md5(job["file"].encode()).hexdigest() + ".mp3")
    tts(job["text"], cfg["voice"], raw)
    encode_trimmed(raw, OUT / job["file"], cfg)
    raw.unlink(missing_ok=True)
    return {"method": "standalone"}


def make_prefix(job, cfg, tmpdir):
    """前綴放進「前綴，A二十三號。」再切在逗號停頓處，讓語尾維持接續語調、不拖長。
    找不到可信的切點就退回單獨合成（並在 manifest 標記 method）。"""
    base = Path(tmpdir) / hashlib.md5(job["file"].encode()).hexdigest()
    alone, carrier = base.with_suffix(".alone.mp3"), base.with_suffix(".carrier.mp3")
    tts(job["text"], cfg["voice"], alone)
    tts(job["text"] + CARRIER_TAIL, cfg["voice"], carrier)
    dur, _ = voiced_duration(alone)
    sil = silences(carrier)
    lead = sil[0][1] if sil and sil[0][0] < 0.01 and sil[0][1] else 0.0
    target = lead + dur
    cands = [s for s, e in sil if s > lead + 0.1 and e is not None]
    best = min(cands, key=lambda s: abs(s - target), default=None)
    try:
        if best is not None and abs(best - target) <= max(0.25, 0.3 * dur):
            encode_trimmed(carrier, OUT / job["file"], cfg, cut_at=best + cfg["trim"]["keepTailMs"] / 1000)
            return {"method": "carrier-cut"}
        encode_trimmed(alone, OUT / job["file"], cfg)
        return {"method": "standalone-fallback"}
    finally:
        alone.unlink(missing_ok=True)
        carrier.unlink(missing_ok=True)


# 叮咚：ffmpeg aevalsrc 純合成，無外部素材
def _note(f, t0, dec, partials=((1, 1.0), (2, 0.35), (3, 0.12))):
    body = "+".join(f"{a}*sin(2*PI*{f * m:.2f}*(t-{t0}))" for m, a in partials)
    return f"if(gte(t,{t0}),({body})*exp(-{dec}*(t-{t0}))*min(1,(t-{t0})/0.004),0)"


BELL = ((0.5, 0.25), (1, 1.0), (1.19, 0.4), (1.5, 0.3), (2.0, 0.35), (2.74, 0.18), (3.0, 0.1))
CHIMES = {
    "chime.dingdong": ("經典叮咚（E5→C5 兩音）", "chime/dingdong.mp3", 1.9,
                       [_note(659.25, 0, 2.6), _note(523.25, 0.5, 2.2)]),
    "chime.bright": ("輕快三音（C5→E5→G5）", "chime/bright.mp3", 1.4,
                     [_note(523.25, 0, 6), _note(659.25, 0.14, 6), _note(783.99, 0.28, 3.2)]),
    "chime.bell": ("柔和鐘聲（D5、A4 兩擊）", "chime/bell.mp3", 2.6,
                   [_note(587.33, 0, 2.2, BELL), "0.6*" + _note(440.0, 0.6, 2.0, BELL)]),
}


def make_chime(job, cfg, tmpdir):
    _, _, dur, notes = CHIMES[job["key"]]
    wav = Path(tmpdir) / (job["key"] + ".wav")
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
         f"aevalsrc='{'+'.join(notes)}':s=48000:d={dur}", str(wav)])
    r = subprocess.run(["ffmpeg", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    peak = float(re.search(r"max_volume: (-?[0-9.]+) dB", r.stderr).group(1))
    gain = -4.0 - peak  # 峰值拉到 -4 dBFS，略低於語音，叮咚不刺耳
    enc = cfg["encode"]
    (OUT / job["file"]).parent.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-af", f"volume={gain:.2f}dB,afade=t=out:st={dur - 0.15}:d=0.15",
         "-ac", "1", "-ar", str(enc["sampleRate"]), "-c:a", "libmp3lame", "-b:a", enc["bitrate"], str(OUT / job["file"])])
    wav.unlink(missing_ok=True)
    return {"method": "ffmpeg-synth"}


# ---------- 工作清單 ----------
def build_jobs(cfg):
    jobs = []
    for key, (name, file, _, _) in CHIMES.items():
        jobs.append({"key": key, "text": name, "file": file, "category": "chime", "maker": "chime"})
    for p in cfg["prefixes"]:
        meta = {k: p[k] for k in ("pack", "tags", "venue", "defaultEnabled", "manualOnly") if k in p}
        jobs.append({"key": p["key"], "text": p["text"], "file": f"prefix/{p['key'].split('.', 1)[1]}.mp3",
                     "category": "prefix", "maker": "prefix", **meta})
    for p in cfg["phrases"]:
        jobs.append({"key": p["key"], "text": p["text"], "file": f"phrase/{p['key'].split('.', 1)[1]}.mp3",
                     "category": "phrase", "maker": "plain"})
    c = cfg["counters"]
    for n in range(c["from"], c["to"] + 1):
        jobs.append({"key": f"counter.{n}", "text": c["pattern"].replace("{n}", zh_number(n)),
                     "file": f"counter/{n:02d}.mp3", "category": "phrase", "subtype": "counter", "maker": "plain"})
    num = cfg["numbers"]
    for L in num["fallbackLetters"]:
        jobs.append({"key": f"letter.{L}", "text": L, "file": f"letter/{L}.mp3",
                     "category": "number", "subtype": "letter", "maker": "plain"})
    for n in range(num["from"], num["to"] + 1):
        jobs.append({"key": f"number._.{n}", "text": zh_number(n) + num["suffix"], "file": f"number/_/{n:03d}.mp3",
                     "category": "number", "subtype": "digits-only", "maker": "plain"})
        for L in num["combinedLetters"]:
            jobs.append({"key": f"number.{L}.{n}", "text": L + zh_number(n) + num["suffix"],
                         "file": f"number/{L}/{n:03d}.mp3", "category": "number", "subtype": "combined",
                         "maker": "plain"})
    return jobs


def job_hash(job, cfg):
    sig = {"v": PIPELINE_VERSION, "text": job["text"], "maker": job["maker"], "voice": cfg["voice"],
           "encode": cfg["encode"], "trim": cfg["trim"]}
    if job["maker"] == "chime":
        sig["chime"] = CHIMES[job["key"]][2:]
    return hashlib.sha256(json.dumps(sig, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


MAKERS = {"plain": make_plain, "prefix": make_prefix, "chime": make_chime}


def generate(cfg, jobs, force, workers):
    cache = json.loads(CACHE.read_text()) if CACHE.exists() and not force else {}
    todo = [j for j in jobs if force or cache.get(j["file"], {}).get("hash") != job_hash(j, cfg)
            or not (OUT / j["file"]).exists()]
    print(f"需產生 {len(todo)} / {len(jobs)} 個檔案", file=sys.stderr)
    failed = []
    with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor(workers) as pool:
        futs = {pool.submit(MAKERS[j["maker"]], j, cfg, tmp): j for j in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            j = futs[fut]
            try:
                info = fut.result()
                cache[j["file"]] = {"hash": job_hash(j, cfg), **info}
            except Exception as e:  # 記下來繼續做，最後統一回報
                failed.append((j["key"], str(e)))
            if i % 200 == 0:
                print(f"  {i}/{len(todo)}", file=sys.stderr)
                CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0))
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0))
    if failed:
        print(f"失敗 {len(failed)} 個：{failed[:10]}", file=sys.stderr)
    return cache, failed


# ---------- manifest ----------
def entry(j, cache):
    p = OUT / j["file"]
    e = {k: j[k] for k in ("key", "text", "file", "category", "subtype", "pack", "tags", "venue",
                           "defaultEnabled", "manualOnly") if k in j}
    e["durationSec"] = probe_duration(p)
    e["bytes"] = p.stat().st_size
    if j["category"] == "prefix":
        e["method"] = cache.get(j["file"], {}).get("method")
    return e


def write_manifest(cfg, jobs, cache):
    with ThreadPoolExecutor(16) as pool:
        entries = list(pool.map(lambda j: entry(j, cache), [j for j in jobs if (OUT / j["file"]).exists()]))
    numbers = [e for e in entries if e.get("subtype") in ("combined", "digits-only")]
    main = [e for e in entries if e not in numbers]
    num = cfg["numbers"]
    total_bytes = sum(e["bytes"] for e in entries)
    manifest = {
        "version": cfg["version"],
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "voice": cfg["voice"],
        "format": {**cfg["encode"], "container": "mp3", "mime": "audio/mpeg",
                   "note": "MP3 是所有瀏覽器（含 iOS Safari、舊版電視盒 WebView）都能 decodeAudioData 的格式"},
        "totals": {"files": len(entries), "bytes": total_bytes,
                   "byCategory": {c: {"files": sum(1 for e in entries if e["category"] == c),
                                      "bytes": sum(e["bytes"] for e in entries if e["category"] == c)}
                                  for c in ("chime", "prefix", "number", "phrase")}},
        "gapsMs": cfg["gapsMs"],
        "rules": {
            "number": {
                "combined": {"letters": num["combinedLetters"], "range": [num["from"], num["to"]],
                             "file": "number/{L}/{NNN}.mp3", "key": "number.{L}.{n}",
                             "note": "字首在 combined 字母內時，字首＋號碼是同一段（一口氣念完最自然）"},
                "fallback": {"steps": ["letter.{L}...", "number._.{n}"], "letterFile": "letter/{L}.mp3",
                             "numberFile": "number/_/{NNN}.mp3", "gapMs": cfg["gapsMs"]["letterToNumber"],
                             "note": "其他字首或兩字元字首：逐字母念，再接純號碼；超出範圍改用 speechSynthesis"},
                "index": "manifest.numbers.json",
            },
            "counter": {"key": "counter.{n}", "file": "counter/{NN}.mp3",
                        "range": [cfg["counters"]["from"], cfg["counters"]["to"]],
                        "note": "「請到 N 號櫃台」整句一段"},
            "prefix": {
                "storeSettings": {"prefixMode": "fun | standard", "enabledPacks": "以主題包勾選（展開成該包的 prefixKeys）", "enabledPrefixKeys": "預設＝defaultEnabled 為 true 的；非餐飲門店應排除 venue=food",
                                  "funProbability": "0～1，每次叫號以此機率用趣味前綴，否則用 prefix.std（建議 0.7）",
                                  "manualPrefixKey": "人員手動指定（生日等 manualOnly 只能這樣用）"},
                "pick": "從啟用清單隨機，避免與上一次相同；同一號碼重複播報（×N）沿用同一個前綴",
            },
            "slots": {"chime": "門店設定的叮咚款式", "prefix": "依 rules.prefix 選", "number": "依 rules.number 解析",
                      "counter": "counter.{櫃台號碼}", "recall": "phrase.recall1 / phrase.recall2 隨機"},
            "gapBetweenSteps": {"chime>*": "afterChime", "prefix>number": "prefixToNumber", "recall>prefix": "recallToPrefix",
                                "number>*": "numberToEnding", "default": 200},
        },
        "prefixPacks": [{**pk, "prefixKeys": [p["key"] for p in cfg["prefixes"] if p["pack"] == pk["key"]]}
                        for pk in cfg["prefixPacks"]],
        "templates": [{**t, "category": "template"} for t in cfg["templates"]],
        "files": main,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    (OUT / "manifest.numbers.json").write_text(json.dumps(
        {"version": cfg["version"], "files": numbers}, ensure_ascii=False, separators=(",", ":")))
    return manifest


# ---------- demo（與面板相同的拼接規則） ----------
def resolve_number(ticket, cfg):
    m = re.fullmatch(r"([A-Z]{1,2})(\d{1,3})", ticket)
    letters, n = m.group(1), int(m.group(2))
    if len(letters) == 1 and letters in cfg["numbers"]["combinedLetters"]:
        return [f"number/{letters}/{n:03d}.mp3"]
    return [f"letter/{L}.mp3" for L in letters] + [f"number/_/{n:03d}.mp3"]


def gap_for(prev, cur, gaps):
    if prev == "chime":
        return gaps["afterChime"]
    if prev.startswith("prefix") and cur == "number":
        return gaps["prefixToNumber"]
    if prev == "recall":
        return gaps["recallToPrefix"]
    if prev == "number":
        return gaps["numberToEnding"]
    return 200


def build_demo(d, cfg):
    gaps, sr = cfg["gapsMs"], cfg["encode"]["sampleRate"]
    tpl = next(t for t in cfg["templates"] if t["key"] == d["template"])
    seq, prev = [], None
    for step in tpl["steps"]:
        if step == "chime":
            files = [CHIMES[d["chime"]][1]]
        elif step == "prefix":
            files = [f"prefix/{d['prefix'].split('.', 1)[1]}.mp3"]
        elif step == "number":
            files = resolve_number(d["ticket"], cfg)
        elif step == "counter":
            files = [f"counter/{d['counter']:02d}.mp3"]
        elif step == "recall":
            files = [f"phrase/{d.get('recall', 'phrase.recall1').split('.', 1)[1]}.mp3"]
        else:  # 固定 key，例如 phrase.seat / prefix.std
            files = [next(j["file"] for j in build_jobs(cfg) if j["key"] == step)]
        kind = "prefix" if step.startswith("prefix") else step if step in ("chime", "number", "recall") else "other"
        if prev:
            seq.append(("gap", gap_for(prev, kind, gaps)))
        for i, f in enumerate(files):
            if i:
                seq.append(("gap", gaps["letterToNumber"]))
            seq.append(("file", f))
        prev = kind
    pcm = bytearray()
    for kind, v in seq:
        if kind == "gap":
            pcm += b"\x00\x00" * int(sr * v / 1000)
        else:
            pcm += run(["ffmpeg", "-v", "error", "-i", str(OUT / v), "-f", "s16le", "-ac", "1", "-ar", str(sr), "-"]).stdout
    dst = OUT / "demo" / d["file"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", "48k", str(dst)], input=bytes(pcm), check=True)
    return dst, [v for k, v in seq if k == "file"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", help="逗號分隔類別：chime,prefix,phrase,number")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--demos-only", action="store_true")
    a = ap.parse_args()
    cfg = json.loads(LINES.read_text())
    jobs = build_jobs(cfg)
    failed = []
    if not a.demos_only:
        sel = [j for j in jobs if not a.only or j["category"] in a.only.split(",")]
        cache, failed = generate(cfg, sel, a.force, a.workers)
        write_manifest(cfg, jobs, cache)
    for d in cfg.get("demos", []):
        dst, parts = build_demo(d, cfg)
        print(f"demo: {dst.relative_to(ROOT)}  ←  {' + '.join(parts)}", file=sys.stderr)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

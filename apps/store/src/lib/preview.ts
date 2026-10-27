/** 語音試聽（05-apps §4）：在店長手機上以 Web Audio 依 manifest 片段拼接播放，不經面板。 */
import type { Segment } from "@qcs/shared/voice/types";

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();
let stopCurrent: (() => void) | null = null;

declare global {
  interface Window {
    __qcsPreviewLog?: string[][];
  }
}

function audio(): AudioContext {
  const C: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  ctx ??= new C();
  return ctx;
}

function load(url: string): Promise<AudioBuffer> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => audio().decodeAudioData(b));
    p.catch(() => buffers.delete(url));
    buffers.set(url, p);
  }
  return p;
}

/** 播放一串片段；回傳播完的 Promise。再次呼叫會先停掉上一段。 */
export async function playSegments(segs: Segment[], volume = 0.8): Promise<void> {
  stopCurrent?.();
  const ac = audio();
  await ac.resume().catch(() => {});
  (window.__qcsPreviewLog ??= []).push(segs.map((s) => s.key));
  const bufs = await Promise.all(segs.map((s) => load(s.url)));
  const gain = ac.createGain();
  gain.gain.value = volume;
  gain.connect(ac.destination);
  let t = ac.currentTime + 0.05;
  const srcs: AudioBufferSourceNode[] = [];
  bufs.forEach((b, i) => {
    t += segs[i].gapBeforeMs / 1000;
    const s = ac.createBufferSource();
    s.buffer = b;
    s.connect(gain);
    s.start(t);
    srcs.push(s);
    t += b.duration;
  });
  const endMs = Math.max(0, (t - ac.currentTime) * 1000);
  await new Promise<void>((resolve) => {
    const h = setTimeout(resolve, endMs);
    stopCurrent = () => {
      clearTimeout(h);
      for (const s of srcs) {
        try {
          s.stop();
        } catch {
          /* not started */
        }
      }
      resolve();
    };
  });
  stopCurrent = null;
}

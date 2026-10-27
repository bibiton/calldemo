/** 前景提醒（07 §1）：同一次點擊解鎖音效，叫號時響鈴＋震動（iOS 無震動，以聲音＋畫面閃爍代替）。 */
let audioCtx: AudioContext | null = null;

/** 播 0.1 秒靜音以解鎖之後的響鈴；必須在使用者點擊的同一個事件內呼叫。 */
export function unlockSound(): void {
  try {
    const C: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    audioCtx = audioCtx ?? new C();
    void audioCtx.resume();
    const b = audioCtx.createBuffer(1, audioCtx.sampleRate / 10, audioCtx.sampleRate);
    const s = audioCtx.createBufferSource();
    s.buffer = b;
    s.connect(audioCtx.destination);
    s.start();
  } catch {
    /* 不支援就略過 */
  }
}

export function soundReady(): boolean {
  return !!audioCtx && audioCtx.state === "running";
}

export function ring(): void {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.5);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.5 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.5 + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + i * 0.5);
    o.stop(t0 + i * 0.5 + 0.45);
  }
  (window as any).__qcsRang = ((window as any).__qcsRang ?? 0) + 1;
}

export function vibrate(): void {
  try {
    navigator.vibrate?.([400, 200, 400, 200, 400]);
  } catch {
    /* iOS 不支援 */
  }
}

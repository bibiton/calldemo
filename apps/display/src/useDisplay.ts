import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { QcsSocket, type PublicTicket, type StoreInfo, type SocketStatus } from "@qcs/shared";
import { API_BASE, wsUrl, store } from "./lib/env";
import { AudioWarmer, warmUrls } from "./audio/warm";
import { createPlanner, type Planner } from "./audio/plan";
import { normalizeVoiceSettings, isMuted } from "./audio/settings";
import { CallQueue } from "./audio/call-queue";
import { AudioGate, detectMode, type AudioStatus } from "./audio/unlock";
import { WebAudioPlayer, type PlayerLog } from "./audio/player";
import type { Manifest } from "./audio/types";
import { AdController } from "./ads/ad-controller";
import { toAnnouncement } from "./announce";

export interface DisplayState {
  store: StoreInfo | null;
  qr: { keyB64: string; keyVersion: number; windowSec: number; baseUrl: string } | null;
  serverOffset: number;
  waiting: Record<string, number>;
  current: PublicTicket | null;
  flashKey: number;
  recent: PublicTicket[];
  suspended: "suspended" | "expired" | null;
}

const initial: DisplayState = { store: null, qr: null, serverOffset: 0, waiting: {}, current: null, flashKey: 0, recent: [], suspended: null };

function reducer(s: DisplayState, m: any): DisplayState {
  const d = m.data ?? {};
  switch (m.type) {
    case "hello":
      return { ...s, store: d.store, qr: d.qr ?? null, serverOffset: d.serverTime - Date.now() };
    case "snapshot": {
      const recent: PublicTicket[] = d.recent ?? [];
      return { ...s, waiting: d.waiting ?? {}, recent, current: recent[0] ?? null, suspended: d.suspended ?? null };
    }
    case "ticket.called": {
      const t: PublicTicket = d;
      const recent = [t, ...s.recent.filter((r) => r.id !== t.id)].slice(0, 10);
      return { ...s, waiting: d.waiting ?? s.waiting, recent, current: t, flashKey: s.flashKey + 1 };
    }
    case "store.suspended":
      return { ...s, suspended: d.reason ?? "suspended" };
    default:
      if (m.type?.startsWith("ticket.") && d.waiting) return { ...s, waiting: d.waiting };
      return s;
  }
}

declare global {
  interface Window {
    __qcsAudioLog?: PlayerLog[];
    __qcsAudio?: { gate: AudioGate; queue: CallQueue };
  }
}

export function useDisplay(token: string, storeId: string, onRevoked: () => void = () => {}) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [adsVersion, setAdsVersion] = useState(0);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;
  const warmer = useMemo(() => new AudioWarmer((u) => fetch(u).then((r) => void r.arrayBuffer())), []);
  const [conn, setConn] = useState<SocketStatus>("connecting");
  const [gateView, setGateView] = useState({ prompt: false, alert: false });
  const [incomplete, setIncomplete] = useState(false);
  const ads = useMemo(() => new AdController(), []);
  const sockRef = useRef<QcsSocket | null>(null);
  const plannerRef = useRef<Planner | null>(null);
  const settingsRef = useRef(normalizeVoiceSettings({}));
  const offsetRef = useRef(0);

  const audio = useMemo(() => {
    window.__qcsAudioLog = [];
    const player = new WebAudioPlayer((e) => window.__qcsAudioLog!.push(e));
    player.onIncomplete = () => setIncomplete(true);
    const mode = detectMode(navigator.userAgent, window as any);
    const client = mode === "app" ? ((window as any).QCSNative?.info?.().client ?? "android_app") : "browser";
    const report = (a: AudioStatus) => sockRef.current?.send({ t: "status", audio: a, client, appVersion: "web-0.1.0" });
    let lastReported: AudioStatus | null = null;
    const gate = new AudioGate({
      mode,
      ctx: player.ctx,
      report: (a) => {
        lastReported = a;
        report(a);
      },
      onUnlocked: () => {
        const p = plannerRef.current?.chimeOnly();
        if (p) void player.play(p).catch(() => {});
      },
    });
    const queue = new CallQueue({
      play: async (item) => {
        const plan = plannerRef.current?.plan(item);
        if (!plan) return;
        player.setVolume(settingsRef.current.volume);
        try {
          await player.play(plan);
        } catch (e) {
          gate.onPlayError(e);
          gate.onCallWhileBlocked();
          throw e;
        }
      },
      // 叫號播放時暫停廣告與背景下載語音（07 §7：播放時暫停下載）
      onBusyChange: (busy) => {
        if (busy) {
          ads.pauseForCall();
          warmer.pause();
        } else {
          ads.resumeAfterCall();
          warmer.resume();
        }
      },
    });
    window.__qcsAudio = { gate, queue };
    return { player, gate, queue, mode, resend: () => lastReported && report(lastReported) };
  }, [ads, warmer]);

  // 語音 manifest（隨 display 靜態部署，ADR-026）
  useEffect(() => {
    let alive = true;
    fetch("/audio/manifest.json")
      .then((r) => r.json())
      .then((m: Manifest) => {
        if (!alive) return;
        plannerRef.current = createPlanner(m, settingsRef.current);
        (window as any).__qcsManifest = m;
        const keep = new Set(["chime", "phrase"]);
        audio.player.preload(m.files.filter((f) => keep.has(f.category) || f.key === "prefix.std").map((f) => "/audio/" + f.file));
      })
      .catch(() => setIncomplete(true));
    return () => {
      alive = false;
    };
  }, [audio]);

  // 解鎖狀態與使用者操作（遙控器 OK／鍵盤／點擊）
  useEffect(() => {
    const off = audio.gate.subscribe(() => setGateView(audio.gate.view));
    audio.gate.check();
    const onEvt = (e: Event) => void audio.gate.handleUserEvent({ type: e.type, key: (e as KeyboardEvent).key });
    const types = ["keydown", "pointerup", "mousedown", "touchend"];
    for (const t of types) window.addEventListener(t, onEvt);
    const iv = setInterval(() => audio.gate.check(), 10_000);
    return () => {
      off();
      clearInterval(iv);
      for (const t of types) window.removeEventListener(t, onEvt);
    };
  }, [audio]);

  // WebSocket
  useEffect(() => {
    const seqKey = `qcs.display.lastSeq.${storeId}`;
    const s = new QcsSocket({
      url: (lastSeq) => wsUrl(`/ws/store/${storeId}?role=display${lastSeq != null ? `&lastSeq=${lastSeq}` : ""}`),
      protocols: () => ["qcs.v1", `auth.${token}`],
      initialLastSeq: null, // 面板重開一律拿 snapshot；同一次執行內重連才用 lastSeq 補推
      onSeq: (n) => store.set(seqKey, String(n)),
      onStatus: (st, code) => {
        setConn(st);
        if (st === "open") audio.resend();
        // 4001＝店長解除配對：確認 token 真的失效才回配對畫面（避免網路瞬斷誤判）
        if (code === 4001)
          void fetch(`${API_BASE}/api/display/ads/manifest`, { headers: { authorization: `Bearer ${token}` } })
            .then((r) => {
              if (r.status === 401) {
                s.stop();
                revokedRef.current();
              }
            })
            .catch(() => {});
      },
      onMessage: (m) => {
        if (m.t !== "evt") return;
        if (m.type === "hello") {
          offsetRef.current = m.data.serverTime - Date.now();
          settingsRef.current = normalizeVoiceSettings(m.data.store?.voiceSettings);
          const man = (window as any).__qcsManifest as Manifest | undefined;
          if (man) {
            plannerRef.current = createPlanner(man, settingsRef.current);
            warmer.enqueue(warmUrls(man, settingsRef.current, m.data.store?.services ?? []));
          }
        }
        if (m.type === "store.closed") s.send({ t: "resync" });
        // 門店改了設定（語音、櫃台、QR 金鑰…）：重連取新的 hello，下一次叫號即套用（3.3）
        if (m.type === "settings.changed") {
          s.stop();
          s.start();
        }
        if (m.type === "ads.manifest") setAdsVersion(m.data?.version ?? Date.now());
        dispatch(m);
        const item = toAnnouncement(m, Date.now() + offsetRef.current);
        if (item) {
          const hhmm = new Date(Date.now() + offsetRef.current).toTimeString().slice(0, 5);
          if (isMuted(settingsRef.current, hhmm)) return;
          if (audio.gate.blocked) audio.gate.onCallWhileBlocked();
          audio.queue.enqueue(item);
        }
      },
    });
    sockRef.current = s;
    s.start();
    return () => s.stop();
  }, [token, storeId, audio]);

  return { state, conn, gateView, incomplete, ads, adsVersion, mode: audio.mode };
}

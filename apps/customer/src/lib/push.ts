/** Web Push 訂閱（07 §2）：權限請求必須在使用者點擊的同一個事件內開始。 */
import { api } from "./api";

export type PushState = "on" | "denied" | "unsupported" | "off" | "pending";

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerSw(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function keyBytes(b64u: string): Uint8Array {
  const p = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * 請求權限並訂閱。呼叫端必須在 click handler 內「同步」呼叫（函式第一步就是 requestPermission）。
 * 回傳 null 表示沒拿到（不支援、拒絕、推播服務不可用）——照常取號，號碼頁提示保持頁面開啟。
 */
export async function requestSubscription(publicKey: string | null | undefined): Promise<{ sub: PushSubscriptionJSON | null; state: PushState }> {
  if (!publicKey || !pushSupported()) return { sub: null, state: "unsupported" };
  let perm: NotificationPermission = Notification.permission;
  try {
    // 已封鎖時 requestPermission 會立即回 denied、不跳提示，所以除了 granted 以外都問一次（有些瀏覽器初始值不可靠）
    if (perm !== "granted") perm = await Notification.requestPermission();
  } catch {
    return { sub: null, state: "unsupported" };
  }
  if (perm !== "granted") return { sub: null, state: perm === "denied" ? "denied" : "off" };
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 8000);
    const key = keyBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      if (cur.length !== key.length || cur.some((b, i) => b !== key[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub = sub ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }));
    return { sub: sub.toJSON(), state: "on" };
  } catch {
    return { sub: null, state: "unsupported" };
  }
}

export async function saveSubscription(ticketId: string, token: string, sub: PushSubscriptionJSON): Promise<boolean> {
  try {
    await api(`/api/tickets/${ticketId}/push`, { method: "POST", token, body: JSON.stringify(sub) });
    return true;
  } catch {
    return false;
  }
}

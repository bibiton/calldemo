/** API 位址：本機走 Vite proxy（同源）；部署時 VITE_API_BASE＝https://api.<domain>。 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
/** 語音素材（試聽用）：本機 /audio/；部署時 https://display.<domain>/audio/ */
export const AUDIO_BASE: string = (import.meta.env.VITE_AUDIO_BASE as string | undefined) ?? "/audio/";

export function wsUrl(path: string): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws") + path;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

export const local = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

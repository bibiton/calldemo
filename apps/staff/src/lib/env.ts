/** API 位址：本機走 Vite proxy（同源）；部署時以 VITE_API_BASE 指向 https://api.<domain>。 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export function wsUrl(path: string): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws") + path;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(p + "=".repeat((4 - (p.length % 4)) % 4)))));
  } catch {
    return null;
  }
}

/** localStorage 可能被擋（私密模式等），一律包 try/catch。 */
export const store = {
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
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

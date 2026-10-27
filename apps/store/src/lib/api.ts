/**
 * 門店後台 API client：access token 只放記憶體（15 分鐘），過期或 401 時用 HttpOnly refresh cookie 換新（06 §1）。
 * refresh 失敗 → 回登入頁；403 STORE_SUSPENDED／EXPIRED → 停用畫面。
 */
import { API_BASE } from "./env";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any = {}) {
    super(code);
  }
}

interface Session {
  token: string;
  expiresAt: number;
  user: { id: string; displayName: string };
}

let session: Session | null = null;
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<(s: "in" | "out" | "suspended" | "expired") => void>();

export const auth = {
  get session() {
    return session;
  },
  get token() {
    return session?.token ?? null;
  },
  on(fn: (s: "in" | "out" | "suspended" | "expired") => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(s: "in" | "out" | "suspended" | "expired") {
    for (const l of listeners) l(s);
  },
  set(s: Session | null) {
    session = s;
  },
};

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(API_BASE + path, { ...init, credentials: "include" });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
}

/** 用 refresh cookie 換 access token；多個請求同時過期時只換一次。 */
export function refresh(): Promise<Session | null> {
  refreshing ??= (async () => {
    const res = await raw("/api/store/auth/refresh", { method: "POST" }).catch(() => null);
    if (res?.status === 403) {
      const b = await res.json().catch(() => ({}));
      auth.emit(b.code === "STORE_EXPIRED" ? "expired" : "suspended");
      return null;
    }
    if (!res?.ok) return null;
    const b = await res.json();
    session = { token: b.accessToken, expiresAt: b.expiresAt, user: b.user };
    return session;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 距離過期不到 60 秒就先換新（WS 連線也用這個拿 token）。 */
export async function freshToken(): Promise<string | null> {
  if (session && session.expiresAt - Date.now() > 60_000) return session.token;
  return (await refresh())?.token ?? null;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const go = async (token: string | null) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    return raw(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  let res = await go(await freshToken());
  if (res.status === 401) {
    const s = await refresh();
    if (!s) {
      session = null;
      auth.emit("out");
      throw new ApiError(401, "TOKEN_INVALID");
    }
    res = await go(s.token);
  }
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    if (res.status === 403 && (body?.code === "STORE_SUSPENDED" || body?.code === "STORE_EXPIRED")) auth.emit(body.code === "STORE_EXPIRED" ? "expired" : "suspended");
    throw new ApiError(res.status, body?.code ?? "ERROR", body ?? {});
  }
  return (body ?? res) as T;
}

export async function login(email: string, password: string): Promise<void> {
  const res = await raw("/api/store/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, b.code ?? "ERROR", b);
  session = { token: b.accessToken, expiresAt: b.expiresAt, user: b.user };
  auth.emit("in");
}

export async function logout(): Promise<void> {
  await raw("/api/store/auth/logout", { method: "POST" }).catch(() => {});
  session = null;
  auth.emit("out");
}

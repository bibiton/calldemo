/**
 * 總後台 API client。身分由 Cloudflare Access 處理（瀏覽器帶 CF_Authorization cookie，Access 在前面注入 JWT），
 * 前端不存任何 token；API 與頁面同源（/api/admin/*，ADR-047）。401 → 顯示「需要重新登入」。
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any = {}) {
    super(code);
  }
}

const listeners = new Set<() => void>();
export const onUnauthorized = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin", body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const body = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    if (res.status === 401) for (const l of listeners) l();
    throw new ApiError(res.status, body?.code ?? "ERROR", body ?? {});
  }
  return body as T;
}

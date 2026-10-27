/** 門店資訊（/api/store/me）：各頁共用一份快取，設定變更後 reload。 */
import { useEffect, useState } from "react";
import type { StoreInfo } from "@qcs/shared";
import { api } from "./api";

export interface Me {
  user: { id: string; displayName: string };
  store: StoreInfo & { status: string; expiresAt: number | null; notifyAhead: number };
  limits: { maxDevices: number; maxStaff: number; adQuotaBytes: number };
}

let cache: Me | null = null;
let inflight: Promise<Me> | null = null;
const subs = new Set<(m: Me) => void>();

function load(force = false): Promise<Me> {
  if (cache && !force) return Promise.resolve(cache);
  inflight ??= api<Me>("/api/store/me")
    .then((m) => {
      cache = m;
      for (const s of subs) s(m);
      return m;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateMe(): void {
  void load(true).catch(() => {});
}

export function useMe() {
  const [data, setData] = useState<Me | null>(cache);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    subs.add(setData);
    setError(null);
    load(n > 0)
      .then(setData)
      .catch(() => setError("讀取門店資料失敗，請稍後再試。"));
    return () => {
      subs.delete(setData);
    };
  }, [n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

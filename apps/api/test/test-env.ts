import { env as cfEnv } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env";

export const env = cfEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

/**
 * env 覆寫（prototype 疊加）。必須用 defineProperty：Object.assign 會經由原型鏈觸發 env proxy 的 set，
 * 把覆寫值寫回共用的 env（污染其他測試與 DO）。
 */
export function envWith(over: Record<string, unknown>): Env & { TEST_MIGRATIONS: D1Migration[] } {
  const o = Object.create(env as object);
  for (const [k, v] of Object.entries(over)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

import type { Context } from "hono";
import type { Env } from "../env";
import type { StoreRecord } from "../lib/store-ctx";
import type { StoreQueueDO } from "../do/store-queue";
import type { JwtClaims } from "../lib/jwt";
import type { PlatformAdmin } from "../lib/access";

export type AppEnv = { Bindings: Env; Variables: { admin: JwtClaims; rec: StoreRecord; platform: PlatformAdmin; sid: string } };
export type C = Context<AppEnv>;

export const err = (c: C, status: number, code: string, extra: Record<string, unknown> = {}) => c.json({ code, ...extra }, status as any);

/** 各路由模組共用：時鐘、門店讀取（含開通檢查）、DO stub。 */
export interface Deps {
  now: () => number;
  storeOr: (c: C, storeId: string) => Promise<StoreRecord | Response>;
  stub: (c: C, storeId: string) => DurableObjectStub<StoreQueueDO>;
}

export const isStr = (x: unknown, min: number, max: number): x is string =>
  typeof x === "string" && x.trim().length >= min && [...x.trim()].length <= max;
export const isInt = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

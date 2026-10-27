import { env as cfEnv } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env";

export const env = cfEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

import type { Env } from "../src/env";
declare global {
  namespace Cloudflare {
    interface Env extends import("../src/env").Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
export type { Env };

#!/usr/bin/env node
// E2E 專用 API：清空獨立 state → migration＋seed → wrangler dev（port 8788，不影響開發用的 8787）
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const api = resolve(root, "apps/api");
const state = resolve(root, ".e2e-state");
rmSync(state, { recursive: true, force: true });
execFileSync("node", ["scripts/seed-local.mjs", "--persist-to", state, "--out", resolve(state, "seed-output.json")], { cwd: api, stdio: "inherit" });
const child = spawn(
  resolve(api, "node_modules/.bin/wrangler"),
  ["dev", "--env", "local", "--port", "8788", "--ip", "127.0.0.1", "--persist-to", state,
   "--var", "CUSTOMER_BASE_URL:http://localhost:6175", "--var", "MEDIA_BASE:http://localhost:6174"],
  { cwd: api, stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (c) => process.exit(c ?? 0));

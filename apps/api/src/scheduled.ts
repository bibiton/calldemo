import type { Env } from "./env";

const DAY = 24 * 3600_000;

/** 保留期限清理（08 §9）：每批 LIMIT 5000 分次刪。 */
export async function runRetention(env: Env, now: number): Promise<Record<string, number>> {
  const jobs: [string, string, number][] = [
    ["tickets_history", "ended_at", now - 90 * DAY],
    ["push_subscriptions", "created_at", now - DAY],
    ["audit_logs", "at", now - 365 * DAY],
    ["transfer_codes", "expires_at", now],
  ];
  const out: Record<string, number> = {};
  for (const [table, col, cutoff] of jobs) {
    let total = 0;
    for (;;) {
      const r = await env.DB.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT 5000)`,
      ).bind(cutoff).run();
      const n = r.meta.changes ?? 0;
      total += n;
      if (n < 5000) break;
    }
    out[table] = total;
  }
  return out;
}

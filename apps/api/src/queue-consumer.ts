import type { Env, HistoryMessage } from "./env";
import { recomputeLateDays, usageStatements } from "./usage/rollup";

/** q-history consumer：批次 INSERT OR IGNORE（冪等），刪除該批推播訂閱，寫稽核與裝置音訊狀態。 */
export async function handleHistoryBatch(batch: MessageBatch<HistoryMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await writeHistory(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error("history write failed", e);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

export async function writeHistory(env: Env, m: HistoryMessage): Promise<void> {
  if (m?.kind !== "history") return;
  const stmts: D1PreparedStatement[] = [];
  const ins = env.DB.prepare(
    `INSERT OR IGNORE INTO tickets_history(id,store_id,business_date,service_id,number,final_status,name_masked,phone_hmac,phone_masked,
      counter_id,staff_id,recall_count,transfer_count,created_at,called_at,serving_at,ended_at,source)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of m.rows) {
    stmts.push(
      ins.bind(r.id, r.store_id, r.business_date, r.service_id, r.number, r.final_status, r.name_masked, r.phone_hmac, r.phone_masked,
        r.counter_id, r.staff_id, r.recall_count, r.transfer_count, r.created_at, r.called_at, r.serving_at, r.ended_at, r.source),
    );
    stmts.push(env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id=?").bind(r.id));
  }
  const aud = env.DB.prepare(
    "INSERT OR IGNORE INTO audit_logs(id,at,actor_type,actor_id,store_id,action,target,detail) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const a of m.audits) stmts.push(aud.bind(a.id, a.at, a.actor_type, a.actor_id, a.store_id, a.action, a.target, a.detail));
  for (const d of m.devices ?? []) {
    if (!d.deviceId) continue;
    // 佇列不保證順序：只套用比 D1 現有狀態新的（ADR-045）
    stmts.push(
      env.DB.prepare(
        "UPDATE devices SET audio_status=?, audio_status_at=?, client_kind=COALESCE(?, client_kind) WHERE id=? AND store_id=? AND (audio_status_at IS NULL OR audio_status_at <= ?)",
      ).bind(d.audio, d.at, d.client ?? null, d.deviceId, m.storeId, d.at),
    );
  }
  stmts.push(...usageStatements(env, m.storeId, m.usage ?? []));
  if (stmts.length) await env.DB.batch(stmts);
  await recomputeLateDays(env, m.storeId, m.usage ?? [], Date.now());
}

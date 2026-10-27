/**
 * q-push consumer（07-notifications §4）：DO 只送「哪個號碼發生什麼事」，這裡從 D1 讀訂閱、加密、送 push service。
 * 404／410 → 刪訂閱；429／5xx／網路錯誤 → retry（最多 3 次）；其他 4xx → 丟棄並記錄。一批最多 25 則並行。
 */
import type { Env, PushMessage } from "./env";
import { buildPushRequest, importVapid, type VapidKeys } from "./lib/webpush";
import { pushStatements } from "./usage/rollup";

export type { PushMessage };

const MAX_RETRIES = 3;
const TTL_S: Record<PushMessage["t"], number> = { called: 120, skipped: 120, soon: 300 };

export interface PushDeps {
  fetch?: (req: Request) => Promise<Response>;
  now?: () => number;
}

let vapidCache: { key: string; keys: Promise<VapidKeys> } | null = null;

function vapid(env: Env): Promise<VapidKeys> | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const k = env.VAPID_PUBLIC_KEY + env.VAPID_PRIVATE_KEY;
  if (vapidCache?.key !== k) {
    vapidCache = {
      key: k,
      keys: importVapid({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:ops@example.com" }),
    };
  }
  return vapidCache.keys;
}

/** 文字由 Service Worker 組（payload 只帶資料，07 §4）。 */
export function payloadOf(m: PushMessage) {
  return { t: m.t, n: m.n, c: m.c, a: m.ahead, r: m.recall, id: m.ticketId, url: `/t/${m.ticketId}` };
}

function retryDelay(res: Response | null, attempts: number): number {
  const ra = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(300, Math.ceil(ra));
  return 5 * 2 ** (attempts - 1);
}

export async function handlePushBatch(batch: MessageBatch<PushMessage>, env: Env, deps: PushDeps = {}): Promise<void> {
  const send = deps.fetch ?? ((r: Request) => fetch(r));
  const now = deps.now ?? (() => Date.now());
  const keysP = vapid(env);
  if (!keysP) {
    console.warn("push disabled: VAPID keys missing");
    batch.ackAll();
    return;
  }
  const keys = await keysP;
  const ids = [...new Set(batch.messages.map((m) => m.body?.ticketId).filter(Boolean))];
  const subs = new Map<string, { endpoint: string; p256dh: string; auth: string }>();
  if (ids.length) {
    const rows = await env.DB.prepare(`SELECT ticket_id, endpoint, p256dh, auth FROM push_subscriptions WHERE ticket_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ ticket_id: string; endpoint: string; p256dh: string; auth: string }>();
    for (const r of rows.results) subs.set(r.ticket_id, r);
  }

  // 每批依店計數（ADR-044）：最終結果才計（成功＝sent；放棄／訂閱失效＝sent＋failed；重試中不計）
  const counts = new Map<string, { sent: number; failed: number }>();
  const tally = (storeId: string, failed: boolean) => {
    const c = counts.get(storeId) ?? { sent: 0, failed: 0 };
    c.sent++;
    if (failed) c.failed++;
    counts.set(storeId, c);
  };

  await Promise.all(
    batch.messages.map(async (msg) => {
      const m = msg.body;
      const sub = m?.kind === "push" ? subs.get(m.ticketId) : undefined;
      if (!sub) return msg.ack();
      let res: Response | null = null;
      try {
        const req = await buildPushRequest(keys, sub, payloadOf(m), { ttl: TTL_S[m.t] ?? 120, urgency: "high", topic: `t${m.ticketId.slice(-20)}` }, now());
        res = await send(req);
      } catch (e) {
        if (e instanceof Error && /p256dh|auth secret|payload/.test(e.message)) {
          console.error("push: bad subscription, dropping", m.ticketId, e.message);
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id=?").bind(m.ticketId).run();
          tally(m.storeId, true);
          return msg.ack();
        }
        console.warn("push: network error", m.ticketId, String(e));
      }
      if (res && res.status >= 200 && res.status < 300) {
        tally(m.storeId, false);
        return msg.ack();
      }
      if (res && (res.status === 404 || res.status === 410)) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id=?").bind(m.ticketId).run();
        tally(m.storeId, true);
        return msg.ack();
      }
      const retriable = !res || res.status === 429 || res.status >= 500;
      if (retriable && msg.attempts <= MAX_RETRIES) return msg.retry({ delaySeconds: retryDelay(res, msg.attempts) });
      console.error("push: giving up", m.ticketId, res?.status ?? "network", "attempts", msg.attempts);
      tally(m.storeId, true);
      msg.ack();
    }),
  );
  const stmts = pushStatements(env, counts, now());
  if (stmts.length) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error("push usage write failed", String(e)); // 計量失敗不影響推播
    }
  }
}

import { app } from "./app";
import { handleHistoryBatch } from "./queue-consumer";
import { handlePushBatch } from "./push-consumer";
import { runRetention } from "./scheduled";
import { runDailyStats } from "./reports";
import { runUsageCron } from "./usage/cron";
import type { Env, HistoryMessage, PushMessage } from "./env";

export { StoreQueueDO } from "./do/store-queue";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<HistoryMessage | PushMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    // 佇列名稱依環境不同（本機 qcs-push-local／正式 call-push-production，ADR-049）：以「push」片段判斷
    if (/(^|-)push(-|$)/.test(batch.queue)) await handlePushBatch(batch as MessageBatch<PushMessage>, env);
    else await handleHistoryBatch(batch as MessageBatch<HistoryMessage>, env);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const t = controller.scheduledTime || Date.now();
    if (controller.cron === "30 19 * * *") await runRetention(env, t);
    if (controller.cron === "5 * * * *") {
      await runDailyStats(env, t);
      await runUsageCron(env, t);
    }
  },
} satisfies ExportedHandler<Env, HistoryMessage | PushMessage>;

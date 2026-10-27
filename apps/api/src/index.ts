import { app } from "./app";
import { handleHistoryBatch } from "./queue-consumer";
import { runRetention } from "./scheduled";
import type { Env, HistoryMessage } from "./env";

export { StoreQueueDO } from "./do/store-queue";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<HistoryMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleHistoryBatch(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "30 19 * * *") await runRetention(env, Date.now());
  },
} satisfies ExportedHandler<Env, HistoryMessage>;

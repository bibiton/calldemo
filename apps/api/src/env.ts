import type { StoreQueueDO } from "./do/store-queue";

export interface Env {
  DB: D1Database;
  LICENSE: KVNamespace;
  MEDIA: R2Bucket;
  STORE_QUEUE: DurableObjectNamespace<StoreQueueDO>;
  Q_HISTORY: Queue<HistoryMessage>;
  Q_PUSH: Queue<unknown>;
  ENV: "local" | "staging" | "production";
  DEV_BYPASS_ACCESS?: string;
  APP_ORIGINS: string;
  MEDIA_BASE: string;
  CUSTOMER_BASE_URL: string;
  JWT_SECRET: string;
  PHONE_PEPPER: string;
  QR_ROOT_SECRET: string;
}

/** DO → q-history 的批次訊息（ADR-009）。rows 已去個資。 */
export interface HistoryMessage {
  kind: "history";
  storeId: string;
  rows: HistoryRow[];
  audits: AuditRow[];
  usage: unknown[];
  devices?: { deviceId: string; audio: string; client: string; at: number }[];
}

export interface HistoryRow {
  id: string;
  store_id: string;
  business_date: string;
  service_id: string;
  number: string;
  final_status: "done" | "skipped" | "no_show" | "cancelled";
  name_masked: string | null;
  phone_hmac: string | null;
  phone_masked: string | null;
  counter_id: string | null;
  staff_id: string | null;
  recall_count: number;
  transfer_count: number;
  created_at: number;
  called_at: number | null;
  serving_at: number | null;
  ended_at: number;
  source: "qr" | "staff";
}

export interface AuditRow {
  id: string;
  at: number;
  actor_type: "staff" | "device" | "system";
  actor_id: string;
  store_id: string;
  action: string;
  target: string | null;
  detail: string | null;
}

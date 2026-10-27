import type { StoreQueueDO } from "./do/store-queue";

export interface Env {
  DB: D1Database;
  LICENSE: KVNamespace;
  MEDIA: R2Bucket;
  STORE_QUEUE: DurableObjectNamespace<StoreQueueDO>;
  Q_HISTORY: Queue<HistoryMessage>;
  Q_PUSH: Queue<PushMessage>;
  ENV: "local" | "staging" | "production";
  DEV_BYPASS_ACCESS?: string;
  APP_ORIGINS: string;
  MEDIA_BASE: string;
  CUSTOMER_BASE_URL: string;
  JWT_SECRET: string;
  PHONE_PEPPER: string;
  QR_ROOT_SECRET: string;
  /** Web Push（07 §4）：未設定時整個推播功能關閉（顧客頁只靠前景 WS）。 */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** DO → q-push（ADR-010）：只帶號碼與事件，訂閱金鑰由 consumer 從 D1 讀，DO 不碰。 */
export interface PushMessage {
  kind: "push";
  storeId: string;
  ticketId: string;
  t: "called" | "soon" | "skipped";
  n: string;
  c: number | null;
  ahead: number;
  recall: number;
  at: number;
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

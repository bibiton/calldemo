import type { StoreQueueDO } from "./do/store-queue";

export interface Env {
  DB: D1Database;
  LICENSE: KVNamespace;
  MEDIA: R2Bucket;
  STORE_QUEUE: DurableObjectNamespace<StoreQueueDO>;
  Q_HISTORY: Queue<HistoryMessage>;
  Q_PUSH: Queue<PushMessage>;
  ENV: "local" | "staging" | "production";
  /** 部署版本（git short sha，deploy.sh 帶入）；本機沒有 */
  VERSION?: string;
  DEV_BYPASS_ACCESS?: string;
  /** Cloudflare Access（總後台，08 §7）：Application AUD tag 與 team domain（xxx.cloudflareaccess.com） */
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  /** 允許進入總後台的 email（逗號分隔）。Access policy 用同一份名單；Worker 再檢查一次 */
  ACCESS_ALLOWED_EMAILS?: string;
  /** Workers Analytics Engine（每 API 請求 1 個 data point，12 §2）；本機不綁定 → 不寫 */
  USAGE?: AnalyticsEngineDataset;
  /** Analytics Engine SQL API（每日 Cron 匯入 usage_hourly）：帳號 id、dataset 名、唯讀 token（Account Analytics Read） */
  CF_ACCOUNT_ID?: string;
  AE_DATASET?: string;
  AE_API_TOKEN?: string;
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
  /** DEMO 門店模擬叫號的間隔秒數（features.demo＋demoSimulate）；預設 20，限制 10～600 */
  DEMO_SIM_EVERY_SEC?: string;
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
  usage: UsageBucket[];
  devices?: { deviceId: string | null; audio: string; client: string | null; at: number }[];
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

/** DO 用量小時桶（12 §2）：隨既有 state 列落地、隨 q-history 送出。 */
export interface UsageBucket {
  h: string; // UTC 小時 "2026-10-27T05"
  wsConn: number;
  wsIn: number;
  rpc: number;
  alarms: number;
  tickets: number;
  calls: number;
  events: number;
  wakes: number;
  rowsW: number;
}

export type StoreStatus = "active" | "suspended" | "expired" | "deleted";

export interface Alert {
  kind: "night_wake" | "request_spike" | "per_ticket" | "ad_quota" | "panel_muted" | "push_fail";
  level: "amber" | "red";
  text: string;
}

export interface StoreSummary {
  id: string;
  code: string;
  name: string;
  brandId: string;
  brandName: string | null;
  status: StoreStatus;
  expiresAt: number | null;
  timezone: string;
  maxDevices: number;
  maxStaff: number;
  adQuotaBytes: number;
  features: Record<string, boolean>;
  displays?: number;
  monthEstUsd?: number;
  monthAllocatedUsd?: number | null;
  alerts?: Alert[];
  createdAt: number;
}

export interface MonthRow {
  store_id: string;
  active_days: number;
  api_requests: number;
  api_errors: number;
  ws_connects: number;
  ws_messages: number;
  do_requests_est: number;
  do_active_seconds_est: number;
  do_rows_written_est: number;
  do_wakes_offhours: number;
  tickets: number;
  calls: number;
  push_sent: number;
  push_failed: number;
  r2_byte_days: number;
  est_cost_usd: number;
  allocated_cost_usd: number | null;
}

export const STATUS_TEXT: Record<StoreStatus, string> = { active: "營業中", suspended: "已停用", expired: "已到期", deleted: "已刪除" };
export const STATUS_TONE: Record<StoreStatus, "green" | "red" | "amber" | "slate"> = { active: "green", suspended: "red", expired: "amber", deleted: "slate" };

export const ACTION_TEXT: Record<string, string> = {
  "store.create": "建立門店",
  "store.update": "修改門店設定",
  "store.extend": "變更到期日",
  "store.suspend": "停用門店",
  "store.resume": "恢復門店",
  "store.delete": "刪除門店",
  "store.hours": "修改營業時間",
  "store.voice": "修改叫號語音",
  "store.settings": "修改門店設定（店長）",
  "user.create": "新增帳號",
  "user.reset": "重設店長密碼",
  "user.reset_pin": "重設人員 PIN",
  "user.disable": "停用帳號",
  "user.enable": "啟用帳號",
  "user.locked": "登入失敗鎖定",
  "device.pair": "配對裝置",
  "device.revoke": "移除裝置",
  "qr.rotate": "重設 QR 金鑰",
  "ad.upload": "上傳廣告",
  "ad.delete": "刪除廣告",
  "pii.reveal": "查看完整手機號碼",
  "service.create": "新增服務類別",
  "service.update": "修改服務類別",
  "service.delete": "刪除服務類別",
  "counter.create": "新增櫃台",
  "counter.update": "修改櫃台",
  "counter.delete": "刪除櫃台",
  "billing.input": "輸入帳單",
  "brand.create": "新增品牌",
  "brand.update": "修改品牌",
  "brand.delete": "刪除品牌",
};

export const ACTOR_TEXT: Record<string, string> = { platform_admin: "平台", store_admin: "店長", staff: "人員", device: "裝置", system: "系統" };

export const LINE_TEXT: Record<string, { label: string; basis: string }> = {
  workers_base: { label: "Workers 月費", basis: "活躍門店平均" },
  workers_requests: { label: "Workers 請求", basis: "依 API 請求數" },
  workers_cpu: { label: "Workers CPU", basis: "依 API 請求數" },
  do_requests: { label: "Durable Objects 請求", basis: "依 DO 請求（估）" },
  do_duration: { label: "Durable Objects 時長", basis: "依 DO 活躍秒（估）" },
  do_storage: { label: "Durable Objects 儲存", basis: "依 DO 寫入列（估）" },
  d1: { label: "D1 資料庫", basis: "依號碼數" },
  kv: { label: "KV", basis: "依 API 請求數" },
  r2: { label: "R2 儲存", basis: "依廣告容量 × 天數" },
  queues: { label: "Queues", basis: "依推播＋歷史批次" },
  analytics_engine: { label: "Analytics Engine", basis: "依 API 請求數" },
  other: { label: "其他", basis: "依估算成本占比" },
};

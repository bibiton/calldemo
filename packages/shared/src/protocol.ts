/** WebSocket 協定型別（04-realtime-protocol §3）。 */
import type { BusinessHour } from "./business-date";

export type Role = "display" | "staff" | "customer";

export type TicketStatus = "waiting" | "called" | "serving" | "done" | "skipped" | "no_show" | "cancelled";
export const ACTIVE_STATUSES: TicketStatus[] = ["waiting", "called", "serving"];

export interface ServiceInfo {
  id: string;
  name: string;
  prefix: string;
  sortOrder?: number;
  /** 每日取號上限；null／undefined = 不限 */
  dailyLimit?: number | null;
}
export interface CounterInfo {
  id: string;
  name: string;
  number: number;
  serviceIds: string[];
}

export interface StoreInfo {
  id: string;
  code: string;
  name: string;
  logoUrl: string | null;
  timezone: string;
  businessHours: BusinessHour[];
  features: Record<string, boolean>;
  services: ServiceInfo[];
  counters: CounterInfo[];
  voiceSettings?: Record<string, unknown>;
  /** 前面剩幾位時發「快輪到您了」推播（1～5，預設 3） */
  notifyAhead?: number;
}

export interface ServerEvent<T = any> {
  t: "evt";
  seq: number;
  at: number;
  type: string;
  data: T;
}

export interface HelloData {
  serverTime: number;
  seq: number;
  role: Role;
  store: StoreInfo;
  qr?: { keyB64: string; keyVersion: number; windowSec: number; baseUrl: string };
}

/** 給面板／顧客看的號碼（無個資）。 */
export interface PublicTicket {
  id: string;
  number: string;
  serviceId: string;
  status: TicketStatus;
  counterId: string | null;
  counterNo: number | null;
  recallCount: number;
  calledAt: number | null;
  nameMasked?: string;
}

/** 人員端看的號碼（含姓名原文與遮罩手機）。 */
export interface StaffTicket extends PublicTicket {
  name: string | null;
  phoneMasked: string | null;
  createdAt: number;
  source: "qr" | "staff";
  transferCount: number;
}

export interface Snapshot {
  businessDate: string;
  waiting: Record<string, number>;
  counters: Record<string, PublicTicket | null>;
  recent: PublicTicket[];
  staff?: { waiting: StaffTicket[]; active: StaffTicket[]; skipped: StaffTicket[] };
  /** staff 版：連線中的面板與音訊狀態（ADR-027 音訊被擋警示） */
  devices?: { deviceId: string | null; audio: string | null }[];
  mine?: (PublicTicket & { ahead: number; etaMin: number }) | null;
  suspended?: "suspended" | "expired" | null;
}

export type StaffCmd =
  | "callNext"
  | "call"
  | "recall"
  | "startServing"
  | "finish"
  | "skip"
  | "requeue"
  | "noShow"
  | "transfer"
  | "createTicket"
  | "revealPhone";

export interface CmdMessage {
  t: "cmd";
  cmdId: string;
  cmd: StaffCmd;
  args: Record<string, any>;
}

export interface AckMessage {
  t: "ack";
  cmdId: string;
  ok: boolean;
  seq?: number;
  result?: any;
  error?: string;
}

export interface StatusMessage {
  t: "status";
  audio: "ok" | "blocked";
  client: "android_app" | "fully" | "chrome_kiosk" | "browser";
  appVersion?: string;
}

/** 補推判定：at 早於現在 30 秒以上的 ticket.called 只更新畫面、不播放（04 §3）。 */
export const REPLAY_STALE_MS = 30_000;

export function formatNumber(prefix: string, no: number): string {
  return prefix + String(no).padStart(3, "0");
}

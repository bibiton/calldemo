/**
 * StoreQueueDO：每店一個（ADR-001）。Hibernation 規範見 04-realtime-protocol §2，由 scripts/check-hibernation.mjs 把關：
 * 只用 ctx.acceptWebSocket＋handler、無計時器、無對外 fetch、心跳走 setWebSocketAutoResponse、連線狀態放 attachment。
 */
import { DurableObject } from "cloudflare:workers";
import {
  ACTIVE_STATUSES,
  businessDate,
  closeAlarmAt,
  formatNumber,
  hmacSha256,
  maskName,
  maskPhone,
  normalizePhone,
  toHex,
  ulid,
  validateName,
  zonedTimeToUtc,
  type PublicTicket,
  type Snapshot,
  type StaffTicket,
  type StoreInfo,
  type TicketStatus,
} from "@qcs/shared";
import type { AuditRow, Env, HistoryMessage, HistoryRow, PushMessage, UsageBucket } from "../env";
import { DO_MIGRATIONS } from "./schema";
import { notifyAheadOf, pushKindFor } from "./push-triggers";
import { isOffHours } from "../usage/hours";

export interface License {
  status: "active" | "suspended";
  expiresAt: number | null;
}

/** Worker 每次轉交時帶入的門店資訊（04 §1、06 §2 第 4 步）。 */
export interface StoreCtx {
  store: StoreInfo;
  license: License;
  /** 門店設定版本（D1 stores.updated_at，單調遞增）。較舊的 ctx 不覆蓋 DO 內較新的設定（isolate 快取最多落後 60 秒）。 */
  v?: number;
  qr?: { keyB64: string; keyVersion: number; windowSec: number; baseUrl: string };
}

export interface Attachment {
  role: "display" | "staff" | "customer";
  ticketId?: string;
  staffId?: string;
  deviceId?: string;
  audio?: string;
  client?: string;
  ahead?: number;
  status?: string;
}

export interface TakeInput {
  jti: string;
  serviceId: string;
  name: string;
  phone: string;
}

export type TakeResult =
  | { ok: true; ticket: PublicTicket & { ahead: number; etaMin: number }; existing: boolean }
  | { ok: false; status: number; code: string };

interface Row {
  [k: string]: SqlStorageValue;
  id: string;
  business_date: string;
  service_id: string;
  prefix: string;
  no: number;
  number: string;
  status: TicketStatus;
  name: string | null;
  phone: string | null;
  phone_hmac: string;
  counter_id: string | null;
  staff_id: string | null;
  recall_count: number;
  transfer_count: number;
  push_enabled: number;
  push_soon_sent: number;
  source: "qr" | "staff";
  sort_key: number;
  /** 入隊序號（ADR-042）：取號時配發，隊尾重排時重新配發；排序鍵 (sort_key, ord) */
  ord: number;
  /** 叫號序號：叫號／重叫時配發；同一毫秒的叫號以此決定先後 */
  call_seq: number;
  created_at: number;
  called_at: number | null;
  serving_at: number | null;
  ended_at: number | null;
  flushed: number;
}

interface Evt {
  seq: number;
  at: number;
  type: string;
  data: any;
}

type Usage = UsageBucket;
type DeviceStatus = NonNullable<HistoryMessage["devices"]>[number];
interface State {
  seq: number;
  /** ord／call_seq 的單調計數（ADR-042）；跟 seq 同一列，每次交易本來就要寫 */
  ord: number;
  u: Usage;
  uh: Usage[];
}

/** 未送出的小時桶上限（約 8 天）：一直沒有關店 alarm 的門店不會讓 state 列無限長大 */
const MAX_PENDING_BUCKETS = 200;

interface CmdOutcome {
  ok: boolean;
  error?: string;
  result?: any;
  events: Evt[];
}

const TERMINAL: TicketStatus[] = ["done", "no_show", "cancelled"];
const HISTORY_BATCH = 25;
const REPLAY_MAX_GAP = 200;
const DEFAULT_SERVICE_MS = 3 * 60_000;
const DAY_MS = 24 * 3600_000;
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");

/** Header 只能 ASCII：JSON 以 encodeURIComponent 包一層。 */
export const encodeHeader = (o: unknown): string => encodeURIComponent(JSON.stringify(o));
export function decodeHeader<T>(v: string | null): T | null {
  if (!v) return null;
  try {
    return JSON.parse(decodeURIComponent(v)) as T;
  } catch {
    return null;
  }
}

const emptyUsage = (h: string): Usage => ({ h, wsConn: 0, wsIn: 0, rpc: 0, alarms: 0, tickets: 0, calls: 0, events: 0, wakes: 0, rowsW: 0 });

export class StoreQueueDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private clock: (() => number) | null = null;
  private state!: State;
  private cfg: StoreInfo | null = null;
  private cfgJson = "";
  private license: License = { status: "active", expiresAt: null };
  private licenseJson = "";
  private cfgV = 0;
  private qr: StoreCtx["qr"] | null = null;

  /** 測試用：本機沒有 Analytics Engine binding 時，夜間喚醒點寫到這裡（模組層級，跨 DO 實例保留）。 */
  static aeSink: { writeDataPoint(p: AnalyticsEngineDataPoint): void } | null = null;

  /** 測試／觀測用（記憶體，不落地）。 */
  debug = { messagesHandled: 0, instanceId: crypto.randomUUID() };
  captureHistory = false;
  /** 用量計量開關（T18 比較開／關時的 rows written；正式環境永遠開啟） */
  private metering = true;
  captured: HistoryMessage[] = [];
  capturePush = false;
  capturedPush: PushMessage[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.load();
      this.usage("wakes");
      this.nightWake();
    });
  }

  // ---------- 基礎 ----------

  setClock(fn: (() => number) | null): void {
    this.clock = fn;
  }

  setMetering(on: boolean): void {
    this.metering = on;
  }

  private now(): number {
    return this.clock ? this.clock() : Date.now();
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const v = Number(this.metaGet("schema_version") ?? "0");
    for (let i = v; i < DO_MIGRATIONS.length; i++) {
      this.sql.exec(DO_MIGRATIONS[i]);
      this.metaSet("schema_version", String(i + 1));
    }
  }

  private load(): void {
    const s = this.metaGet("state");
    this.state = s ? JSON.parse(s) : { seq: 0, ord: 0, u: emptyUsage(this.hourKey()), uh: [] };
    if (typeof this.state.ord !== "number") {
      // schema v3 之前建立的 DO：從既有號碼接續（回填的 ord 不會大於目前最大值）
      this.state.ord = this.sql.exec<{ m: number | null }>("SELECT max(max(ord), max(call_seq)) AS m FROM tickets").one().m ?? 0;
    }
    const c = this.metaGet("config");
    if (c) {
      this.cfgJson = c;
      this.cfg = JSON.parse(c);
    }
    const l = this.metaGet("license_json");
    if (l) {
      this.licenseJson = l;
      this.license = JSON.parse(l);
    }
    this.cfgV = Number(this.metaGet("config_v") ?? "0");
    const q = this.metaGet("qr_json");
    if (q) this.qr = JSON.parse(q);
  }

  private metaGet(key: string): string | null {
    const r = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key=?", key).toArray();
    return r.length ? r[0].value : null;
  }

  private metaSet(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }

  private hourKey(): string {
    return new Date(this.now()).toISOString().slice(0, 13);
  }

  /** 用量計數只在記憶體累加，隨下一次本來就要寫的 state 列落地（ADR-019）。 */
  private usage(field: keyof Omit<Usage, "h">, n = 1): void {
    if (!this.state || !this.metering) return;
    const h = this.hourKey();
    if (this.state.u.h !== h) {
      this.state.uh.push(this.state.u);
      if (this.state.uh.length > MAX_PENDING_BUCKETS) this.state.uh.splice(0, this.state.uh.length - MAX_PENDING_BUCKETS);
      this.state.u = emptyUsage(h);
    }
    this.state.u[field] = (this.state.u[field] ?? 0) + n; // 舊版 state 沒有新欄位
  }

  /**
   * 非營業時間被喚醒：直接寫 1 個 Analytics Engine 點（ADR-044）。記憶體計數只有之後有寫入才會落地，
   * 而「夜裡被喚醒卻什麼都沒做」正是 hibernation 失效的樣子 → 這種喚醒要另外記。白天不寫（量大且正常）。
   * writeDataPoint 不等待、不是對外 fetch，不影響 hibernation、不增加 SQLite 寫入。
   */
  private nightWake(): void {
    if (!this.metering || !this.cfg) return;
    if (!isOffHours(this.now(), this.tz, this.cfg.businessHours ?? [])) return;
    try {
      (this.env.USAGE ?? StoreQueueDO.aeSink)?.writeDataPoint({ indexes: [this.cfg.id], blobs: ["wake", "DO", "-", "do"], doubles: [1, 0] });
    } catch {
      /* 計量失敗不影響服務 */
    }
  }

  private applyCtx(ctx: StoreCtx): void {
    const v = ctx.v ?? 0;
    if (v < this.cfgV) return; // 舊版本（其他 isolate 的快取），忽略
    if (v > this.cfgV) {
      this.cfgV = v;
      this.metaSet("config_v", String(v));
    }
    if (ctx.qr && JSON.stringify(ctx.qr) !== JSON.stringify(this.qr)) {
      this.qr = ctx.qr;
      this.metaSet("qr_json", JSON.stringify(ctx.qr));
    }
    const s = JSON.stringify(ctx.store);
    if (s !== this.cfgJson) {
      this.metaSet("config", s);
      this.cfgJson = s;
      this.cfg = ctx.store;
    }
    const l = JSON.stringify(ctx.license);
    if (l !== this.licenseJson) {
      this.metaSet("license_json", l);
      this.licenseJson = l;
      this.license = ctx.license;
    }
  }

  private licenseError(): "suspended" | "expired" | null {
    if (this.license.status !== "active") return "suspended";
    if (this.license.expiresAt != null && this.license.expiresAt < this.now()) return "expired";
    return null;
  }

  private get tz(): string {
    return this.cfg?.timezone ?? "Asia/Taipei";
  }

  /** 交易：狀態變更＋events＋state 同一交易；失敗時記憶體 state 一併還原。 */
  private tx<T>(fn: () => T): T {
    const backup = JSON.stringify(this.state);
    try {
      return this.ctx.storage.transactionSync(() => {
        const r = fn();
        this.usage("rowsW"); // state 列本身（估算值，12 §2）
        this.metaSet("state", JSON.stringify(this.state));
        return r;
      });
    } catch (e) {
      this.state = JSON.parse(backup);
      throw e;
    }
  }

  /** 下一個 ord／call_seq：只在交易內呼叫，隨 state 列落地（ADR-042）。 */
  private nextOrd(): number {
    return ++this.state.ord;
  }

  private emit(type: string, data: any): Evt {
    const seq = ++this.state.seq;
    const at = this.now();
    const payload = { ...data, waiting: this.waitingCounts() };
    this.sql.exec("INSERT INTO events(seq,at,type,payload) VALUES(?,?,?,?)", seq, at, type, JSON.stringify(payload));
    this.usage("events");
    this.usage("rowsW", 2); // 事件列＋造成事件的號碼列
    return { seq, at, type, data: payload };
  }

  // ---------- 查詢與視圖 ----------

  private ticket(id: string): Row | null {
    const r = this.sql.exec<Row>("SELECT * FROM tickets WHERE id=?", id).toArray();
    return r.length ? r[0] : null;
  }

  private waitingCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.cfg?.services ?? []) out[s.id] = 0;
    for (const r of this.sql.exec<{ service_id: string; n: number }>(
      "SELECT service_id, count(*) AS n FROM tickets WHERE status='waiting' GROUP BY service_id",
    )) {
      out[r.service_id] = r.n;
    }
    return out;
  }

  private counterNo(counterId: string | null): number | null {
    return this.cfg?.counters.find((c) => c.id === counterId)?.number ?? null;
  }

  private pub(r: Row): PublicTicket {
    const out: PublicTicket = {
      id: r.id,
      number: r.number,
      serviceId: r.service_id,
      status: r.status,
      counterId: r.counter_id,
      counterNo: this.counterNo(r.counter_id),
      recallCount: r.recall_count,
      calledAt: r.called_at,
    };
    if (this.cfg?.features?.showMaskedName && r.name) out.nameMasked = maskName(r.name);
    return out;
  }

  private staffView(r: Row): StaffTicket {
    return {
      ...this.pub(r),
      name: r.name,
      phoneMasked: r.phone ? maskPhone(r.phone) : null,
      createdAt: r.created_at,
      source: r.source,
      transferCount: r.transfer_count,
      sortKey: r.sort_key,
      ord: r.ord,
    };
  }

  private position(r: Row): { ahead: number; etaMin: number } {
    if (r.status !== "waiting") return { ahead: 0, etaMin: 0 };
    const ahead = this.aheadOf(r);
    const avg = this.sql
      .exec<{ a: number | null }>(
        "SELECT avg(ended_at - called_at) AS a FROM tickets WHERE status='done' AND called_at IS NOT NULL AND business_date=?",
        r.business_date,
      )
      .one().a;
    const per = avg && avg > 0 ? Math.min(Math.max(avg, 60_000), 30 * 60_000) : DEFAULT_SERVICE_MS;
    const counters = Math.max(1, this.cfg?.counters.filter((c) => !c.serviceIds.length || c.serviceIds.includes(r.service_id)).length ?? 1);
    return { ahead, etaMin: Math.ceil((ahead * per) / counters / 60_000) };
  }

  private mine(r: Row) {
    return { ...this.pub(r), ...this.position(r) };
  }

  private snapshot(att: Attachment): Snapshot {
    const bd = businessDate(this.now(), this.tz);
    const counters: Record<string, PublicTicket | null> = {};
    for (const c of this.cfg?.counters ?? []) {
      const r = this.sql
        .exec<Row>("SELECT * FROM tickets WHERE counter_id=? AND status IN ('called','serving') ORDER BY called_at DESC, call_seq DESC LIMIT 1", c.id)
        .toArray();
      counters[c.id] = r.length ? this.pub(r[0]) : null;
    }
    const recent = this.sql
      .exec<Row>("SELECT * FROM tickets WHERE called_at IS NOT NULL AND business_date=? ORDER BY called_at DESC, call_seq DESC LIMIT 10", bd)
      .toArray()
      .map((r) => this.pub(r));
    const snap: Snapshot = { businessDate: bd, waiting: this.waitingCounts(), counters, recent, suspended: this.licenseError() };
    if (att.role === "staff") {
      const q = (where: string) =>
        this.sql.exec<Row>(`SELECT * FROM tickets WHERE ${where} ORDER BY sort_key, ord`).toArray().map((r) => this.staffView(r));
      snap.staff = { waiting: q("status='waiting'"), active: q("status IN ('called','serving')"), skipped: q("status='skipped'") };
      // 目前連線中的面板與音訊狀態（門店後台／人員端一開就能看到「無法出聲」警示，不必等下一次狀態改變）
      snap.devices = this.ctx.getWebSockets("role:display").map((ws) => {
        const a = ws.deserializeAttachment() as Attachment | null;
        return { deviceId: a?.deviceId ?? null, audio: a?.audio ?? null };
      });
    }
    if (att.role === "customer" && att.ticketId) {
      const r = this.ticket(att.ticketId);
      snap.mine = r ? this.mine(r) : null;
    }
    return snap;
  }

  /** 依角色過濾／加工事件；null = 此角色不可見。 */
  private viewFor(att: Attachment, e: Evt): Evt | null {
    if (e.type.startsWith("store.")) return e;
    if (att.role === "display") return e;
    if (att.role === "staff") {
      const r = e.data?.id ? this.ticket(e.data.id) : null;
      return r ? { ...e, data: { ...e.data, ...this.staffView(r), waiting: e.data.waiting } } : e;
    }
    if (att.role === "customer" && e.data?.id === att.ticketId) {
      const r = this.ticket(att.ticketId!);
      return r ? { ...e, data: { ...e.data, ...this.mine(r), waiting: undefined } } : e;
    }
    return null;
  }

  private sendJson(ws: WebSocket, o: unknown): void {
    try {
      ws.send(JSON.stringify(o));
    } catch {
      /* 連線已斷，交給 webSocketClose */
    }
  }

  private evtMsg(e: Evt) {
    return { t: "evt", seq: e.seq, at: e.at, type: e.type, data: e.data };
  }

  private broadcast(events: Evt[]): void {
    if (!events.length) return;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      for (const e of events) {
        const v = this.viewFor(att, e);
        if (v) this.sendJson(ws, this.evtMsg(v));
      }
      if (att.role === "customer") this.pushPosition(ws, att);
    }
  }

  /** queue.position 只推給前面人數或狀態有變的顧客（不佔 seq）。 */
  private pushPosition(ws: WebSocket, att: Attachment): void {
    const r = att.ticketId ? this.ticket(att.ticketId) : null;
    if (!r) return;
    const p = this.position(r);
    if (p.ahead === att.ahead && r.status === att.status) return;
    att.ahead = p.ahead;
    att.status = r.status;
    ws.serializeAttachment(att);
    this.sendJson(ws, { t: "evt", at: this.now(), type: "queue.position", data: { ticketId: r.id, status: r.status, ...p } });
  }

  // ---------- WebSocket 連線（Worker 已驗證身分與開通狀態後轉交）----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("Upgrade") !== "websocket") return new Response("not found", { status: 404 });
    const sctx = decodeHeader<StoreCtx>(request.headers.get("x-qcs-ctx"));
    const auth = decodeHeader<Attachment>(request.headers.get("x-qcs-auth"));
    if (!sctx || !auth || !["display", "staff", "customer"].includes(auth.role)) return new Response("bad ctx", { status: 400 });
    this.applyCtx(sctx);
    if (this.licenseError()) return new Response(JSON.stringify({ code: "STORE_SUSPENDED" }), { status: 403 });
    if (auth.role === "customer" && (!auth.ticketId || !this.ticket(auth.ticketId))) return new Response("ticket", { status: 404 });

    const pair = new WebSocketPair();
    const server = pair[1];
    const tags = [`role:${auth.role}`];
    if (auth.ticketId) tags.push(`ticket:${auth.ticketId}`);
    this.ctx.acceptWebSocket(server, tags);
    const att: Attachment = { role: auth.role, ticketId: auth.ticketId, staffId: auth.staffId, deviceId: auth.deviceId };
    server.serializeAttachment(att);
    this.usage("wsConn");

    this.sendJson(server, {
      t: "evt",
      at: this.now(),
      type: "hello",
      data: {
        serverTime: this.now(),
        seq: this.state.seq,
        role: auth.role,
        store: this.cfg,
        ...(auth.role === "display" && (this.qr ?? sctx.qr) ? { qr: this.qr ?? sctx.qr } : {}),
      },
    });
    const ls = url.searchParams.get("lastSeq");
    this.replayOrSnapshot(server, att, ls === null || ls === "" ? null : Number(ls));

    const headers = new Headers();
    const proto = request.headers.get("x-qcs-proto");
    if (proto) headers.set("Sec-WebSocket-Protocol", proto);
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  private replayOrSnapshot(ws: WebSocket, att: Attachment, lastSeq: number | null): void {
    const cur = this.state.seq;
    const min = this.sql.exec<{ m: number | null }>("SELECT min(seq) AS m FROM events").one().m;
    const tooOld =
      lastSeq === null ||
      !Number.isFinite(lastSeq) ||
      lastSeq > cur ||
      cur - lastSeq > REPLAY_MAX_GAP ||
      (min === null ? lastSeq < cur : lastSeq < min - 1);
    if (att.role === "customer" || tooOld) {
      this.sendJson(ws, { t: "evt", seq: cur, at: this.now(), type: "snapshot", data: this.snapshot(att) });
      return;
    }
    for (const r of this.sql.exec<{ seq: number; at: number; type: string; payload: string }>(
      "SELECT seq, at, type, payload FROM events WHERE seq > ? ORDER BY seq",
      lastSeq,
    )) {
      const v = this.viewFor(att, { seq: r.seq, at: r.at, type: r.type, data: JSON.parse(r.payload) });
      if (v) this.sendJson(ws, this.evtMsg(v));
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.debug.messagesHandled++;
    this.usage("wsIn");
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    const lic = this.licenseError();
    if (lic) {
      this.sendJson(ws, { t: "evt", at: this.now(), type: "store.suspended", data: { reason: lic } });
      ws.close(4003, lic);
      return;
    }
    if (msg?.t === "resync") {
      this.sendJson(ws, { t: "evt", seq: this.state.seq, at: this.now(), type: "snapshot", data: this.snapshot(att) });
    } else if (msg?.t === "cmd") {
      await this.handleCmd(ws, att, msg);
    } else if (msg?.t === "status" && att.role === "display") {
      await this.handleStatus(ws, att, msg);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 「無法出聲」的面板斷線：回報 offline，警示不殘留（重連後面板會再回報目前狀態）
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === "display" && att.audio === "blocked") {
      await this.deviceStatus({ deviceId: att.deviceId ?? null, audio: "offline", client: att.client ?? null, at: this.now() });
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {
    /* runtime 會接著呼叫 webSocketClose */
  }

  private async handleStatus(ws: WebSocket, att: Attachment, msg: any): Promise<void> {
    const audio = msg.audio === "ok" ? "ok" : msg.audio === "blocked" ? "blocked" : null;
    if (!audio || att.audio === audio) return;
    att.audio = audio;
    att.client = String(msg.client ?? "browser").slice(0, 20);
    ws.serializeAttachment(att);
    await this.deviceStatus({ deviceId: att.deviceId ?? null, audio, client: att.client, at: this.now() });
  }

  /**
   * 面板音訊狀態改變：通知人員端／門店後台，並**立即**經 q-history 寫 D1（總後台「無法出聲」警示要在幾分鐘內出現，
   * 不能等 25 筆歷史批次，ADR-045）。只在狀態改變時發生，量極小；佇列失敗時退回批次緩衝。
   */
  private async deviceStatus(data: DeviceStatus): Promise<void> {
    for (const s of this.ctx.getWebSockets("role:staff")) this.sendJson(s, { t: "evt", at: this.now(), type: "device.status", data });
    const msg: HistoryMessage = { kind: "history", storeId: this.cfg?.id ?? "", rows: [], audits: [], usage: [], devices: [data] };
    if (this.captureHistory) {
      this.captured.push(msg);
      return;
    }
    try {
      await this.env.Q_HISTORY.send(msg);
    } catch (e) {
      console.error("device status enqueue failed; buffering", String(e));
      this.sql.exec("INSERT INTO audit_buffer(id,at,kind,json) VALUES(?,?,?,?)", ulid(this.now()), this.now(), "device", JSON.stringify(data));
    }
  }

  /** 總後台門店詳情：目前連線中的面板與音訊狀態（只在管理員開詳情時呼叫）。 */
  async liveDevices(): Promise<{ deviceId: string | null; audio: string | null; client: string | null }[]> {
    this.usage("rpc");
    return this.ctx.getWebSockets("role:display").map((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return { deviceId: a?.deviceId ?? null, audio: a?.audio ?? null, client: a?.client ?? null };
    });
  }

  // ---------- 取號（Worker RPC）----------

  private async phoneHmac(phone: string): Promise<string> {
    return toHex(await hmacSha256(this.env.PHONE_PEPPER, phone)).slice(0, 32);
  }

  private nextNo(serviceId: string, bd: string): number {
    const r = this.sql
      .exec<{ last_no: number }>(
        "INSERT INTO counters_seq(service_id,business_date,last_no) VALUES(?,?,1) ON CONFLICT(service_id,business_date) DO UPDATE SET last_no=last_no+1 RETURNING last_no",
        serviceId,
        bd,
      )
      .one();
    return r.last_no;
  }

  private insertTicket(serviceId: string, name: string | null, phone: string | null, hmac: string, source: "qr" | "staff"): Row {
    const svc = this.cfg!.services.find((s) => s.id === serviceId)!;
    const now = this.now();
    const bd = businessDate(now, this.tz);
    if (this.metaGet("business_date") !== bd) this.metaSet("business_date", bd); // ADR-008 惰性換日
    const no = this.nextNo(serviceId, bd);
    const id = ulid(now);
    this.sql.exec(
      `INSERT INTO tickets(id,business_date,service_id,prefix,no,number,status,name,phone,phone_hmac,source,sort_key,ord,created_at)
       VALUES(?,?,?,?,?,?,'waiting',?,?,?,?,?,?,?)`,
      id,
      bd,
      serviceId,
      svc.prefix,
      no,
      formatNumber(svc.prefix, no),
      name,
      phone,
      hmac,
      source,
      now,
      this.nextOrd(),
      now,
    );
    this.usage("tickets");
    return this.ticket(id)!;
  }

  async takeTicket(sctx: StoreCtx, input: TakeInput): Promise<TakeResult> {
    this.usage("rpc");
    this.applyCtx(sctx);
    const lic = this.licenseError();
    if (lic) return { ok: false, status: 403, code: lic === "expired" ? "STORE_EXPIRED" : "STORE_SUSPENDED" };
    if (!this.cfg!.services.some((s) => s.id === input.serviceId)) return { ok: false, status: 422, code: "SERVICE_INVALID" };
    const name = validateName(input.name);
    if (!name) return { ok: false, status: 422, code: "NAME_INVALID" };
    const phone = normalizePhone(input.phone);
    if (!phone) return { ok: false, status: 422, code: "PHONE_INVALID" };
    if (typeof input.jti !== "string" || !input.jti) return { ok: false, status: 401, code: "SESSION_INVALID" };
    const hmac = await this.phoneHmac(phone);

    const out = this.tx(() => {
      const now = this.now();
      const sess = this.sql.exec<{ ticket_id: string }>("SELECT ticket_id FROM take_sessions WHERE jti=?", input.jti).toArray();
      if (sess.length) {
        const t = this.ticket(sess[0].ticket_id);
        if (t && t.phone_hmac === hmac && t.name === name && ACTIVE_STATUSES.includes(t.status)) return { row: t, existing: true, events: [] };
        return { error: "SESSION_USED" as const };
      }
      const act = this.sql
        .exec<Row>(`SELECT * FROM tickets WHERE phone_hmac=? AND status IN (${inList(ACTIVE_STATUSES)})`, hmac)
        .toArray();
      if (act.length) {
        if (act[0].name !== name) return { error: "PHONE_ACTIVE" as const };
        this.sql.exec("INSERT INTO take_sessions(jti,at,ticket_id) VALUES(?,?,?)", input.jti, now, act[0].id);
        return { row: act[0], existing: true, events: [] };
      }
      const limit = this.cfg!.services.find((s) => s.id === input.serviceId)?.dailyLimit;
      if (limit) {
        const issued = this.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM tickets WHERE service_id=? AND business_date=?", input.serviceId, businessDate(now, this.tz))
          .one().n;
        if (issued >= limit) return { error: "DAILY_LIMIT" as const };
      }
      const row = this.insertTicket(input.serviceId, name, phone, hmac, "qr");
      this.sql.exec("INSERT INTO take_sessions(jti,at,ticket_id) VALUES(?,?,?)", input.jti, now, row.id);
      return { row, existing: false, events: [this.emit("ticket.created", { ...this.pub(row) })] };
    });
    if ("error" in out) return { ok: false, status: 409, code: out.error! };
    this.broadcast(out.events);
    if (!out.existing) await this.ensureAlarm(out.row.business_date);
    return { ok: true, ticket: this.mine(out.row), existing: out.existing };
  }

  async cancelTicket(sctx: StoreCtx, ticketId: string): Promise<{ ok: boolean; code?: string }> {
    this.usage("rpc");
    this.applyCtx(sctx);
    const out = this.tx(() => {
      const r = this.ticket(ticketId);
      if (!r || !["waiting", "called", "skipped"].includes(r.status)) return null;
      this.sql.exec("UPDATE tickets SET status='cancelled', ended_at=? WHERE id=?", this.now(), ticketId);
      return this.emit("ticket.cancelled", this.pub(this.ticket(ticketId)!));
    });
    if (!out) return { ok: false, code: "BAD_STATE" };
    this.broadcast([out]);
    await this.pushFor([out]);
    await this.maybeFlush();
    return { ok: true };
  }

  async summary(sctx: StoreCtx): Promise<{ waiting: Record<string, number> }> {
    this.usage("rpc");
    this.applyCtx(sctx);
    return { waiting: this.waitingCounts() };
  }

  async ticketView(sctx: StoreCtx, ticketId: string) {
    this.usage("rpc");
    this.applyCtx(sctx);
    const r = this.ticket(ticketId);
    return r ? this.mine(r) : null;
  }

  // ---------- Web Push（07 §1；只在顧客沒開著 WS 時才送，ADR-010 經 q-push）----------

  /** 顧客訂閱後由 Worker 呼叫：標記此號碼要推播。前面人數已在門檻內時視為已提醒（顧客正看著號碼頁）。 */
  async enablePush(sctx: StoreCtx, ticketId: string): Promise<{ ok: boolean; code?: string }> {
    this.usage("rpc");
    this.applyCtx(sctx);
    const r = this.ticket(ticketId);
    if (!r) return { ok: false, code: "TICKET_NOT_FOUND" };
    if (!ACTIVE_STATUSES.includes(r.status) && r.status !== "skipped") return { ok: false, code: "TICKET_ENDED" };
    const soonDone = r.status !== "waiting" || this.aheadOf(r) <= notifyAheadOf(this.cfg);
    this.sql.exec("UPDATE tickets SET push_enabled=1, push_soon_sent=? WHERE id=?", soonDone ? 1 : 0, ticketId);
    return { ok: true };
  }

  private aheadOf(r: Row): number {
    return this.sql
      .exec<{ n: number }>(
        // 排序鍵 (sort_key, ord)：同一毫秒取號以入隊序號決定先後（ADR-042）
        `SELECT count(*) AS n FROM tickets WHERE status='waiting' AND service_id=?
         AND (sort_key < ? OR (sort_key = ? AND ord < ?))`,
        r.service_id,
        r.sort_key,
        r.sort_key,
        r.ord,
      )
      .one().n;
  }

  private pushMsg(r: Row, t: PushMessage["t"], ahead = 0): PushMessage {
    return { kind: "push", storeId: this.cfg?.id ?? "", ticketId: r.id, t, n: r.number, c: this.counterNo(r.counter_id), ahead, recall: r.recall_count, at: this.now() };
  }

  /** 事件之後：叫號／過號通知當事人；隊伍前進時檢查「前面剩 N 位」。都只對已訂閱且頁面不在前景的顧客。 */
  private async pushFor(events: Evt[]): Promise<void> {
    if (!events.length || this.cfg?.features?.push === false) return;
    const online = (id: string) => this.ctx.getWebSockets(`ticket:${id}`).length > 0;
    const out: PushMessage[] = [];
    for (const e of events) {
      const kind = pushKindFor(e.type);
      const r = kind && e.data?.id ? this.ticket(e.data.id) : null;
      if (kind && r && r.push_enabled && !online(r.id)) out.push(this.pushMsg(r, kind));
    }
    if (events.some((e) => e.type.startsWith("ticket."))) {
      const n = notifyAheadOf(this.cfg);
      for (const r of this.sql.exec<Row>("SELECT * FROM tickets WHERE status='waiting' AND push_enabled=1 AND push_soon_sent=0").toArray()) {
        const ahead = this.aheadOf(r);
        if (ahead > n) continue;
        this.sql.exec("UPDATE tickets SET push_soon_sent=1 WHERE id=?", r.id);
        if (!online(r.id)) out.push(this.pushMsg(r, "soon", ahead));
      }
    }
    if (!out.length) return;
    if (this.capturePush) this.capturedPush.push(...out);
    else await this.env.Q_PUSH.sendBatch(out.map((body) => ({ body })));
  }

  // ---------- 停用（06 §2）----------

  async suspend(reason: "suspended" | "expired", license?: License): Promise<void> {
    this.usage("rpc");
    if (license) {
      this.metaSet("license_json", JSON.stringify(license));
      this.licenseJson = JSON.stringify(license);
      this.license = license;
    } else {
      this.license = { ...this.license, status: "suspended" };
      this.licenseJson = JSON.stringify(this.license);
      this.metaSet("license_json", this.licenseJson);
    }
    const e = this.tx(() => this.emit("store.suspended", { reason }));
    this.broadcast([e]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4003, reason);
      } catch {
        /* ignore */
      }
    }
  }

  async resume(sctx: StoreCtx): Promise<void> {
    this.usage("rpc");
    this.applyCtx(sctx);
  }

  /** 門店後台改了設定：套用並廣播 settings.changed（面板重連取新 hello，人員端重抓門店資料）。 */
  async configChanged(sctx: StoreCtx): Promise<void> {
    this.usage("rpc");
    this.applyCtx(sctx);
    const e = this.tx(() => this.emit("settings.changed", { version: this.cfgV }));
    this.broadcast([e]);
  }

  /** 門店後台「今日」報表：直接由 DO 當日資料計算（D1 歷史要關店後才完整）。 */
  async todayStats(sctx: StoreCtx) {
    this.usage("rpc");
    this.applyCtx(sctx);
    const bd = businessDate(this.now(), this.tz);
    const by = new Map<string, Record<string, number>>();
    for (const r of this.sql.exec<{ service_id: string; status: string; n: number }>(
      "SELECT service_id, status, count(*) AS n FROM tickets WHERE business_date=? GROUP BY service_id, status",
      bd,
    )) {
      by.set(r.service_id, { ...(by.get(r.service_id) ?? {}), [r.status]: r.n });
    }
    const waits = new Map<string, number>();
    for (const r of this.sql.exec<{ service_id: string; a: number }>(
      "SELECT service_id, avg(called_at - created_at) AS a FROM tickets WHERE business_date=? AND called_at IS NOT NULL GROUP BY service_id",
      bd,
    )) {
      waits.set(r.service_id, Math.round(r.a));
    }
    const services = (this.cfg?.services ?? []).map((s) => {
      const m = by.get(s.id) ?? {};
      const g = (k: string) => m[k] ?? 0;
      return {
        serviceId: s.id,
        name: s.name,
        prefix: s.prefix,
        issued: Object.values(m).reduce((a, b) => a + b, 0),
        waiting: g("waiting"),
        called: g("called") + g("serving"),
        done: g("done"),
        skipped: g("skipped"),
        noShow: g("no_show"),
        cancelled: g("cancelled"),
        avgWaitMs: waits.get(s.id) ?? null,
      };
    });
    return { businessDate: bd, services };
  }

  /** 廣告播放清單變更：面板收到 ads.manifest{version} 後重抓 manifest（05-apps §1）。 */
  async adsChanged(version: number): Promise<void> {
    this.usage("rpc");
    const e = this.tx(() => this.emit("ads.manifest", { version }));
    this.broadcast([e]);
  }

  /** 解除裝置配對／停用人員：立即關閉該身分的連線（4001），之後重連會被 Worker 以 401 拒絕。 */
  async disconnect(match: { deviceId?: string; staffId?: string }): Promise<number> {
    this.usage("rpc");
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      if ((match.deviceId && att.deviceId === match.deviceId) || (match.staffId && att.staffId === match.staffId)) {
        try {
          ws.close(4001, "revoked");
          n++;
        } catch {
          /* already closed */
        }
      }
    }
    return n;
  }

  // ---------- 人員指令（ADR-007；cmdId 冪等）----------

  private async handleCmd(ws: WebSocket, att: Attachment, msg: any): Promise<void> {
    const cmdId = typeof msg.cmdId === "string" ? msg.cmdId.slice(0, 64) : "";
    if (!cmdId) return;
    if (att.role !== "staff") {
      this.sendJson(ws, { t: "ack", cmdId, ok: false, error: "FORBIDDEN" });
      return;
    }
    const prev = this.sql.exec<{ result: string }>("SELECT result FROM cmd_dedup WHERE cmd_id=?", cmdId).toArray();
    if (prev.length) {
      ws.send(prev[0].result);
      return;
    }
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    // 需要非同步計算的放在交易前
    let pre: { phone: string | null; hmac: string | null } = { phone: null, hmac: null };
    if (msg.cmd === "createTicket" && args.phone) {
      const p = normalizePhone(String(args.phone));
      pre = { phone: p, hmac: p ? await this.phoneHmac(p) : null };
    }
    let ackJson = "";
    let events: Evt[] = [];
    try {
      const r = this.tx(() => {
        const o = this.runCmd(String(msg.cmd), args, att, pre);
        const ack = { t: "ack", cmdId, ok: o.ok, ...(o.ok ? { seq: this.state.seq, result: o.result } : { error: o.error }) };
        const s = JSON.stringify(ack);
        this.sql.exec("INSERT INTO cmd_dedup(cmd_id,at,result) VALUES(?,?,?)", cmdId, this.now(), s);
        return { s, events: o.events, ok: o.ok, bd: o.result?.ticket ? businessDate(this.now(), this.tz) : null };
      });
      ackJson = r.s;
      events = r.events;
      if (r.ok && msg.cmd === "createTicket" && r.bd) await this.ensureAlarm(r.bd);
    } catch (e) {
      ackJson = JSON.stringify({ t: "ack", cmdId, ok: false, error: "INTERNAL" });
      console.error("cmd failed", msg.cmd, e);
    }
    ws.send(ackJson);
    this.broadcast(events);
    await this.pushFor(events);
    await this.maybeFlush();
  }

  private counterOk(counterId: unknown) {
    return this.cfg?.counters.find((c) => c.id === counterId) ?? null;
  }

  private setStatus(id: string, sets: string, ...binds: unknown[]): Row {
    this.sql.exec(`UPDATE tickets SET ${sets} WHERE id=?`, ...binds, id);
    return this.ticket(id)!;
  }

  /** 櫃台叫下一號前，自動結束該櫃台目前的號碼（called／serving → done，ADR-029）。 */
  private closeCounter(counterId: string, events: Evt[]): void {
    const now = this.now();
    for (const r of this.sql
      .exec<Row>("SELECT * FROM tickets WHERE counter_id=? AND status IN ('called','serving')", counterId)
      .toArray()) {
      const t = this.setStatus(r.id, "status='done', ended_at=?", now);
      events.push(this.emit("ticket.done", this.pub(t)));
    }
  }

  private callTicket(r: Row, counterId: string, att: Attachment, events: Evt[]): Row {
    this.closeCounter(counterId, events);
    const t = this.setStatus(r.id, "status='called', counter_id=?, staff_id=?, called_at=?, call_seq=?, recall_count=0", counterId, att.staffId ?? null, this.now(), this.nextOrd());
    events.push(this.emit("ticket.called", this.pub(t)));
    this.usage("calls");
    return t;
  }

  private runCmd(cmd: string, a: any, att: Attachment, pre: { phone: string | null; hmac: string | null }): CmdOutcome {
    const events: Evt[] = [];
    const ok = (t: Row, extra: Record<string, unknown> = {}): CmdOutcome => ({ ok: true, result: { ticket: this.staffView(t), ...extra }, events });
    const fail = (error: string): CmdOutcome => ({ ok: false, error, events: [] });
    const now = this.now();

    if (cmd === "callNext") {
      const c = this.counterOk(a.counterId);
      if (!c) return fail("COUNTER_INVALID");
      let svcs = c.serviceIds.length ? c.serviceIds : this.cfg!.services.map((s) => s.id);
      if (Array.isArray(a.serviceIds) && a.serviceIds.length) svcs = svcs.filter((s) => a.serviceIds.includes(s));
      if (!svcs.length) return fail("QUEUE_EMPTY");
      const r = this.sql
        .exec<Row>(
          `SELECT * FROM tickets WHERE status='waiting' AND service_id IN (${svcs.map(() => "?").join(",")})
           AND (counter_id IS NULL OR counter_id=?) ORDER BY sort_key, ord LIMIT 1`,
          ...svcs,
          c.id,
        )
        .toArray();
      if (!r.length) return fail("QUEUE_EMPTY");
      return ok(this.callTicket(r[0], c.id, att, events));
    }

    if (cmd === "createTicket") {
      if (!this.cfg!.services.some((s) => s.id === a.serviceId)) return fail("SERVICE_INVALID");
      const name = a.name ? validateName(String(a.name)) : null;
      if (a.name && !name) return fail("NAME_INVALID");
      if (a.phone && !pre.phone) return fail("PHONE_INVALID");
      if (pre.hmac) {
        const dup = this.sql.exec(`SELECT id FROM tickets WHERE phone_hmac=? AND status IN (${inList(ACTIVE_STATUSES)})`, pre.hmac).toArray();
        if (dup.length) return fail("PHONE_ACTIVE");
      }
      const hmac = pre.hmac ?? `nophone:${ulid(now)}`;
      const t = this.insertTicket(a.serviceId, name, pre.phone, hmac, "staff");
      events.push(this.emit("ticket.created", this.pub(t)));
      return ok(t);
    }

    const r = typeof a.ticketId === "string" ? this.ticket(a.ticketId) : null;
    if (!r) return fail("TICKET_NOT_FOUND");
    const is = (...s: TicketStatus[]) => s.includes(r.status);

    switch (cmd) {
      case "call": {
        const c = this.counterOk(a.counterId);
        if (!c) return fail("COUNTER_INVALID");
        if (!is("waiting", "skipped")) return fail("BAD_STATE");
        return ok(this.callTicket(r, c.id, att, events));
      }
      case "recall": {
        if (!is("called")) return fail("BAD_STATE");
        const t = this.setStatus(r.id, "recall_count=recall_count+1, called_at=?, call_seq=?", now, this.nextOrd());
        events.push(this.emit("ticket.called", this.pub(t)));
        this.usage("calls");
        return ok(t);
      }
      case "startServing": {
        if (!is("called")) return fail("BAD_STATE");
        const t = this.setStatus(r.id, "status='serving', serving_at=?", now);
        events.push(this.emit("ticket.serving", this.pub(t)));
        return ok(t);
      }
      case "finish": {
        if (!is("called", "serving")) return fail("BAD_STATE");
        const t = this.setStatus(r.id, "status='done', ended_at=?", now);
        events.push(this.emit("ticket.done", this.pub(t)));
        return ok(t);
      }
      case "skip": {
        if (!is("called")) return fail("BAD_STATE");
        const t = this.setStatus(r.id, "status='skipped'");
        events.push(this.emit("ticket.skipped", this.pub(t)));
        return ok(t);
      }
      case "requeue": {
        if (!is("skipped")) return fail("BAD_STATE");
        // 原位：回到取號時的 (sort_key, ord)；隊尾：等同「此刻才入隊」，重新配發 ord（同一毫秒也排在已入隊者之後，ADR-042）
        const t =
          a.position === "original"
            ? this.setStatus(r.id, "status='waiting', counter_id=NULL, sort_key=?", r.created_at)
            : this.setStatus(r.id, "status='waiting', counter_id=NULL, sort_key=?, ord=?", now, this.nextOrd());
        events.push(this.emit("ticket.requeued", this.pub(t)));
        return ok(t);
      }
      case "noShow": {
        if (!is("called", "skipped")) return fail("BAD_STATE");
        const t = this.setStatus(r.id, "status='no_show', ended_at=?", now);
        events.push(this.emit("ticket.no_show", this.pub(t)));
        return ok(t);
      }
      case "transfer": {
        if (!is("waiting", "called", "serving")) return fail("BAD_STATE");
        const toSvc = a.toServiceId ?? r.service_id;
        if (!this.cfg!.services.some((s) => s.id === toSvc)) return fail("SERVICE_INVALID");
        const toCounter = a.toCounterId ?? null;
        if (toCounter && !this.counterOk(toCounter)) return fail("COUNTER_INVALID");
        if (!a.toServiceId && !a.toCounterId) return fail("BAD_ARGS");
        const t = this.setStatus(
          r.id,
          "status='waiting', service_id=?, counter_id=?, transfer_count=transfer_count+1, called_at=NULL, serving_at=NULL",
          toSvc,
          toCounter,
        );
        events.push(this.emit("ticket.transferred", this.pub(t)));
        return ok(t);
      }
      case "revealPhone": {
        this.sql.exec(
          "INSERT INTO audit_buffer(id,at,kind,json) VALUES(?,?,?,?)",
          ulid(now),
          now,
          "audit",
          JSON.stringify({ action: "pii.reveal", actor_id: att.staffId ?? "unknown", target: r.id }),
        );
        return { ok: true, result: { ticketId: r.id, phone: r.phone }, events };
      }
      default:
        return fail("UNKNOWN_CMD");
    }
  }

  // ---------- 關店 alarm、歷史批次（ADR-009、ADR-015）----------

  private async ensureAlarm(bd: string): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) != null) return;
    const now = this.now();
    let at = closeAlarmAt(bd, this.cfg?.businessHours ?? [], this.tz);
    if (at < now + 30 * 60_000) at = Math.max(zonedTimeToUtc(bd, "23:59", this.tz) + 30 * 60_000, now + 60 * 60_000);
    this.metaSet("alarm_bd", bd);
    await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    this.usage("alarms");
    const now = this.now();
    const bd = this.metaGet("alarm_bd") ?? businessDate(now - DAY_MS, this.tz);
    const e = this.tx(() => {
      this.sql.exec(
        "UPDATE tickets SET status='done', ended_at=? WHERE business_date<=? AND status='serving'",
        now,
        bd,
      );
      this.sql.exec(
        "UPDATE tickets SET status='no_show', ended_at=? WHERE business_date<=? AND status IN ('waiting','called','skipped')",
        now,
        bd,
      );
      return this.emit("store.closed", { businessDate: bd });
    });
    await this.flushHistory(true, bd);
    this.sql.exec("UPDATE tickets SET name=NULL, phone=NULL WHERE business_date<=?", bd);
    const cutoff = now - 2 * DAY_MS;
    this.sql.exec("DELETE FROM events WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM cmd_dedup WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM take_sessions WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM tickets WHERE flushed=1 AND business_date < ?", bd);
    this.sql.exec("DELETE FROM counters_seq WHERE business_date < ?", bd);
    this.broadcast([e]);
    // 若已有下一個營業日的號碼（例如午夜後取號），替它排下一個關店 alarm
    const later = this.sql.exec<{ bd: string }>("SELECT min(business_date) AS bd FROM tickets WHERE business_date > ?", bd).one().bd;
    this.metaSet("alarm_bd", "");
    if (later) await this.ensureAlarm(later);
  }

  private async maybeFlush(): Promise<void> {
    const n = this.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM tickets WHERE flushed=0 AND status IN (${inList(TERMINAL)})`)
      .one().n;
    if (n >= HISTORY_BATCH) await this.flushHistory(false);
  }

  private historyRow(r: Row): HistoryRow {
    return {
      id: r.id,
      store_id: this.cfg?.id ?? "",
      business_date: r.business_date,
      service_id: r.service_id,
      number: r.number,
      final_status: r.status as HistoryRow["final_status"],
      name_masked: r.name ? maskName(r.name) : null,
      phone_hmac: r.phone_hmac.startsWith("nophone:") ? null : r.phone_hmac,
      phone_masked: r.phone ? maskPhone(r.phone) : null,
      counter_id: r.counter_id,
      staff_id: r.staff_id,
      recall_count: r.recall_count,
      transfer_count: r.transfer_count,
      created_at: r.created_at,
      called_at: r.called_at,
      serving_at: r.serving_at,
      ended_at: r.ended_at ?? this.now(),
      source: r.source,
    };
  }

  private async flushHistory(all: boolean, _bd?: string): Promise<void> {
    const storeId = this.cfg?.id ?? "";
    if (all && this.metering) {
      this.usage("events", 0); // 讓小時桶依目前時間輪替
      this.state.uh.push(this.state.u);
      this.state.u = emptyUsage(this.hourKey());
    }
    for (;;) {
      const rows = this.sql
        .exec<Row>(`SELECT * FROM tickets WHERE flushed=0 AND status IN (${inList(TERMINAL)}) ORDER BY ended_at LIMIT ${HISTORY_BATCH}`)
        .toArray();
      const audRows = this.sql.exec<{ id: string; at: number; kind: string; json: string }>("SELECT * FROM audit_buffer ORDER BY at LIMIT 50").toArray();
      const usage = this.metering ? this.state.uh : [];
      if (!rows.length && !audRows.length && !usage.length) return;
      if (!all && rows.length < HISTORY_BATCH) return;
      const audits: AuditRow[] = [];
      const devices: NonNullable<HistoryMessage["devices"]> = [];
      for (const a of audRows) {
        const j = JSON.parse(a.json);
        if (a.kind === "device") devices.push(j);
        else audits.push({ id: a.id, at: a.at, actor_type: "staff", actor_id: j.actor_id, store_id: storeId, action: j.action, target: j.target ?? null, detail: null });
      }
      const msg: HistoryMessage = { kind: "history", storeId, rows: rows.map((r) => this.historyRow(r)), audits, usage, devices };
      if (this.captureHistory) this.captured.push(msg);
      else await this.env.Q_HISTORY.send(msg);
      this.tx(() => {
        for (const r of rows) this.sql.exec("UPDATE tickets SET flushed=1 WHERE id=?", r.id);
        for (const a of audRows) this.sql.exec("DELETE FROM audit_buffer WHERE id=?", a.id);
        this.state.uh = [];
      });
      if (rows.length < HISTORY_BATCH && audRows.length < 50) return;
    }
  }
}

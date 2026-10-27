import { env } from "./test-env";
import type { StoreCtx } from "../src/do/store-queue";

export const TZ = "Asia/Taipei";

export function storeCtx(storeId: string, over: Partial<StoreCtx["store"]> = {}, license: Partial<StoreCtx["license"]> = {}): StoreCtx {
  return {
    store: {
      id: storeId,
      code: "C" + storeId.slice(-5).toUpperCase(),
      name: "測試店",
      logoUrl: null,
      timezone: TZ,
      businessHours: [],
      features: {},
      services: [
        { id: "svc_a", name: "內用", prefix: "A" },
        { id: "svc_b", name: "外帶", prefix: "B" },
      ],
      counters: [
        { id: "c1", name: "1 號櫃台", number: 1, serviceIds: ["svc_a"] },
        { id: "c2", name: "2 號櫃台", number: 2, serviceIds: [] },
        { id: "c3", name: "3 號櫃台", number: 3, serviceIds: ["svc_b"] },
      ],
      ...over,
    },
    license: { status: "active", expiresAt: null, ...license },
    qr: { keyB64: "AAAA", keyVersion: 1, windowSec: 120, baseUrl: "http://localhost:5175" },
  };
}

export function stubFor(storeId: string) {
  return env.STORE_QUEUE.get(env.STORE_QUEUE.idFromName(storeId));
}

let n = 0;
export function uniq(prefix = "st"): string {
  return `${prefix}_${Date.now().toString(36)}_${(n++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function phone(i: number): string {
  return "09" + String(10000000 + i).slice(-8);
}

export interface TestSocket {
  ws: WebSocket;
  msgs: any[];
  raw: string[];
  next(pred: (m: any) => boolean, timeoutMs?: number): Promise<any>;
  send(o: unknown): void;
  closed: Promise<number>;
}

export async function openWs(
  storeId: string,
  auth: Record<string, unknown>,
  opts: { lastSeq?: number | null; ctx?: StoreCtx } = {},
): Promise<TestSocket> {
  const ctx = opts.ctx ?? storeCtx(storeId);
  const q = opts.lastSeq != null ? `?lastSeq=${opts.lastSeq}` : "";
  const res = await stubFor(storeId).fetch(`https://do/ws${q}`, {
    headers: { Upgrade: "websocket", "x-qcs-ctx": encodeURIComponent(JSON.stringify(ctx)), "x-qcs-auth": encodeURIComponent(JSON.stringify(auth)) },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  ws.accept();
  const msgs: any[] = [];
  const raw: string[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  let closeResolve!: (c: number) => void;
  const closed = new Promise<number>((r) => (closeResolve = r));
  ws.addEventListener("message", (e) => {
    const s = String(e.data);
    raw.push(s);
    let m: any = s;
    try {
      m = JSON.parse(s);
    } catch {
      /* text */
    }
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  ws.addEventListener("close", (e) => closeResolve(e.code));
  return {
    ws,
    msgs,
    raw,
    send: (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o)),
    closed,
    next(pred, timeoutMs = 3000) {
      const found = msgs.find(pred);
      if (found) {
        msgs.splice(msgs.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for message; got: " + JSON.stringify(msgs).slice(0, 800))), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            msgs.splice(msgs.indexOf(m), 1);
            resolve(m);
          },
        });
      });
    },
  };
}

export const isType = (type: string) => (m: any) => m && m.type === type;
export const isAck = (cmdId: string) => (m: any) => m && m.t === "ack" && m.cmdId === cmdId;

let cmdN = 0;
export function cmdId(): string {
  return `cmd_${Date.now()}_${cmdN++}`;
}

export async function take(storeId: string, i: number, over: Record<string, unknown> = {}) {
  return stubFor(storeId).takeTicket(storeCtx(storeId), {
    jti: `jti_${storeId}_${i}_${Math.random()}`,
    serviceId: "svc_a",
    name: `顧客${i}`,
    phone: phone(i),
    ...over,
  } as any);
}

export async function staffCmd(sock: TestSocket, cmd: string, args: Record<string, unknown> = {}, id = cmdId()) {
  sock.send({ t: "cmd", cmdId: id, cmd, args });
  return sock.next(isAck(id));
}

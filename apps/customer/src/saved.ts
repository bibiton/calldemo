import { store } from "./lib/env";

export interface StoreLite {
  id: string;
  code: string;
  name: string;
  logoUrl?: string | null;
  /** 門店勾選「顯示於顧客手機」的圖片（ADR-048） */
  images?: string[];
  /** DEMO 門店（features.demo）：顯示「DEMO・虛構品牌」浮水印 */
  demo?: boolean;
}
export interface Ticket {
  id: string;
  number: string;
  status: string;
  counterNo: number | null;
  recallCount: number;
  ahead: number;
  etaMin: number;
}
export interface Saved {
  token: string;
  ticketId: string;
  store: StoreLite;
  push?: { publicKey: string } | null;
}

const KEY = "qcs.customer.ticket";

export const savedTicket = {
  get(): Saved | null {
    try {
      return JSON.parse(store.get(KEY) ?? "null");
    } catch {
      return null;
    }
  },
  set(s: Saved): void {
    store.set(KEY, JSON.stringify(s));
  },
  del(): void {
    store.del(KEY);
  },
};

/** 此號碼已成功訂閱推播（重開頁面時直接顯示「背景提醒已開啟」）。 */
export const pushFlag = {
  get: (ticketId: string) => store.get(`qcs.customer.push.${ticketId}`) === "on",
  set: (ticketId: string) => store.set(`qcs.customer.push.${ticketId}`, "on"),
};

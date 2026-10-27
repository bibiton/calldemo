/**
 * M4 4.4 總後台「用量與成本」API：月總覽（實際／估算並列、活躍店數、每店平均）、排行、每店用量頁（今日／本月／30 日趨勢）、
 * 帳單輸入與分攤、CSV 匯出（每日／每月）。
 */
import { describe, expect, it } from "vitest";
import { env, envWith } from "./test-env";
import { createApp } from "../src/app";
import { seedStore } from "./fixtures";

const NOW = Date.UTC(2027, 0, 20, 6); // 2027-01-20
const app = createApp({ now: () => NOW });
const req = (path: string, init: RequestInit = {}, e: unknown = env) => app.request(path, init, e as any);
const put = (path: string, body: unknown) => req(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = async (r: Response) => (await r.json()) as any;

async function hourly(storeId: string, date: string, o: Record<string, number>, hour = 3) {
  const cols = Object.keys(o);
  await env.DB.prepare(`INSERT OR REPLACE INTO usage_hourly(store_id,hour_start,${cols.join(",")}) VALUES(?,?,${cols.map(() => "?").join(",")})`)
    .bind(storeId, Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`), ...Object.values(o))
    .run();
}

async function twoStores() {
  const a = await seedStore();
  const b = await seedStore();
  for (let d = 1; d <= 19; d++) {
    const date = `2027-01-${String(d).padStart(2, "0")}`;
    await hourly(a.storeId, date, { tickets: 100, api_requests: 700, ws_messages: 2000, ws_connects: 10, do_events: 400, do_wakes: 20, do_rows_written: 1200, push_sent: 50 });
    await hourly(b.storeId, date, { tickets: 20, api_requests: 140, ws_messages: 400, ws_connects: 4, do_events: 80, do_wakes: 5, do_rows_written: 240, push_sent: 5 });
  }
  return { a, b };
}

describe("用量總覽（月）", () => {
  it("每店本月加總、估算成本、30 日趨勢；未輸入帳單時實際為 null；依分攤／號碼數／每號成本排序", async () => {
    const { a, b } = await twoStores();
    const r = await req("/api/admin/usage?month=2027-01&sort=tickets");
    expect(r.status).toBe(200);
    const u = await j(r);
    const ra = u.stores.find((x: any) => x.storeId === a.storeId);
    const rb = u.stores.find((x: any) => x.storeId === b.storeId);
    expect(ra.month).toMatchObject({ tickets: 1900, api_requests: 13300, active_days: 19 });
    expect(ra.month.est_cost_usd).toBeGreaterThan(rb.month.est_cost_usd);
    expect(ra.trend).toHaveLength(30);
    expect(ra.trend.at(-2)).toMatchObject({ date: "2027-01-19", tickets: 100 });
    expect(ra.trend.at(-1)).toMatchObject({ date: "2027-01-20", tickets: 0 }); // 今天尚未彙總
    expect(u.overview.actualUsd).toBeNull();
    expect(u.overview.estUsd).toBeGreaterThan(0);
    const idx = (id: string) => u.stores.findIndex((x: any) => x.storeId === id);
    expect(idx(a.storeId)).toBeLessThan(idx(b.storeId));
    const byPer = await j(await req("/api/admin/usage?month=2027-01&sort=per_ticket"));
    const per = byPer.stores.filter((x: any) => x.month.tickets > 0).map((x: any) => x.perTicketUsd);
    expect(per).toEqual([...per].sort((x: number, y: number) => y - x));
  });

  it("月份格式錯誤 → 422；預設本月", async () => {
    expect((await req("/api/admin/usage?month=2027-13")).status).toBe(422);
    expect((await j(await req("/api/admin/usage"))).month).toBe("2027-01");
  });
});

describe("帳單輸入與分攤", () => {
  it("輸入帳單 → 總覽顯示實際金額、每店分攤；寫稽核；清空項目（null）即刪除；負數 → 422", async () => {
    const { a, b } = await twoStores();
    const res = await put("/api/admin/billing", { month: "2027-01", items: { workers_base: 5, workers_requests: 0.6, do_requests: 0.3, d1: 0.2 } });
    expect(res.status).toBe(200);
    const u = await j(await req("/api/admin/usage?month=2027-01&sort=allocated"));
    expect(u.overview.actualUsd).toBeCloseTo(6.1, 6);
    const ra = u.stores.find((x: any) => x.storeId === a.storeId);
    const rb = u.stores.find((x: any) => x.storeId === b.storeId);
    expect(ra.month.allocated_cost_usd).toBeGreaterThan(rb.month.allocated_cost_usd);
    const g = await j(await req("/api/admin/billing?month=2027-01"));
    expect(g.items).toMatchObject({ workers_base: 5, workers_requests: 0.6 });
    expect(g.lineItems).toContain("analytics_engine");
    expect((await put("/api/admin/billing", { month: "2027-01", items: { d1: null } })).status).toBe(200);
    expect((await j(await req("/api/admin/billing?month=2027-01"))).items.d1).toBeUndefined();
    expect((await put("/api/admin/billing", { month: "2027-01", items: { d1: -1 } })).status).toBe(422);
    expect((await put("/api/admin/billing", { month: "2027-01", items: { bogus: 1 } })).status).toBe(422);
    const aud = await env.DB.prepare("SELECT actor_id, detail FROM audit_logs WHERE action='billing.input' ORDER BY at DESC").first<any>();
    expect(aud.actor_id).toBe("dev@local");
  });

  it("已結束的月份輸入帳單 → 立即寫入 usage_monthly 分攤結果", async () => {
    const s = await seedStore();
    await hourly(s.storeId, "2026-12-10", { tickets: 50, api_requests: 300 });
    expect((await put("/api/admin/billing", { month: "2026-12", items: { workers_base: 5 } })).status).toBe(200);
    const m = await env.DB.prepare("SELECT allocated_cost_usd FROM usage_monthly WHERE store_id=? AND month='2026-12'").bind(s.storeId).first<any>();
    expect(m.allocated_cost_usd).toBeGreaterThan(0);
  });
});

describe("每店用量頁", () => {
  it("近 30 日每日用量、本月加總、警示；今日 API 請求（AE 已設定時即時查詢）", async () => {
    const { a } = await twoStores();
    const r = await j(await req(`/api/admin/usage/stores/${a.storeId}`));
    expect(r.store).toMatchObject({ id: a.storeId, name: "測試店" });
    expect(r.days).toHaveLength(30);
    expect(r.days.find((d: any) => d.date === "2027-01-05")).toMatchObject({ tickets: 100 });
    expect(r.month).toMatchObject({ tickets: 1900 });
    expect(r.today).toBeNull(); // 本機未設定 AE
    const aeEnv = envWith({ CF_ACCOUNT_ID: "acc", AE_API_TOKEN: "tok", AE_DATASET: "qcs_usage" });
    const fetched: string[] = [];
    const app2 = createApp({ now: () => NOW, aeFetch: async (rq) => (fetched.push(await rq.text()), Response.json({ data: [{ store: a.storeId, req: 321 }] })) });
    const r2 = (await (await app2.request(`/api/admin/usage/stores/${a.storeId}`, {}, aeEnv)).json()) as any;
    expect(r2.today).toEqual({ apiRequests: 321 });
    expect(fetched[0]).toContain("toDateTime('2027-01-20 00:00:00')");
  });
  it("不存在的門店 → 404", async () => {
    expect((await req("/api/admin/usage/stores/nope")).status).toBe(404);
  });
});

describe("CSV 匯出", () => {
  it("每月：UTF-8 BOM、中文表頭、每店一列、金額小數；每日：每店每日一列", async () => {
    const { a } = await twoStores();
    await put("/api/admin/billing", { month: "2027-01", items: { workers_base: 5 } });
    const m = await req("/api/admin/usage/export.csv?month=2027-01&granularity=monthly");
    expect(m.status).toBe(200);
    expect(m.headers.get("content-type")).toContain("text/csv");
    expect(m.headers.get("content-disposition")).toContain("usage-2027-01-monthly.csv");
    const buf = new Uint8Array(await m.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(buf).replace(/^﻿/, "");
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toContain("門店碼");
    expect(lines[0]).toContain("分攤成本(USD)");
    expect(lines.some((l) => l.includes(a.code) && l.includes("1900"))).toBe(true);
    const d = await req("/api/admin/usage/export.csv?month=2027-01&granularity=daily");
    const dl = new TextDecoder().decode(new Uint8Array(await d.arrayBuffer())).trim().split("\r\n");
    expect(dl.filter((l) => l.includes(a.code))).toHaveLength(19);
  });
  it("欄位含逗號或引號時正確跳脫（防 CSV 注入：= + - @ 開頭加單引號）", async () => {
    const s = await seedStore();
    await env.DB.prepare("UPDATE stores SET name=? WHERE id=?").bind('=HYPERLINK("x"),壞', s.storeId).run();
    await hourly(s.storeId, "2027-01-03", { tickets: 1 });
    const t = new TextDecoder().decode(new Uint8Array(await (await req("/api/admin/usage/export.csv?month=2027-01&granularity=monthly")).arrayBuffer()));
    expect(t).toContain(`"'=HYPERLINK(""x""),壞"`);
  });
});

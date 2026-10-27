#!/usr/bin/env node
/**
 * 5.1 壓測的本機版（k6 版見 k6-call.js，對正式環境跑）。情境同 roadmap 5.1：
 *   單店 N 號（預設 300）在 D 秒內取完（預設 300 秒＝5 分鐘）＋ P 台面板（預設 50）同時連線＋同時叫號廣播；
 *   量測「人員送出叫下一號 → 全部面板都收到 ticket.called」的延遲 p50／p95／max，與取號延遲、錯誤數。
 *
 * 用法（先起本機 API，例如 node e2e/start-api.mjs → 8788）：
 *   node scripts/load/local-load.mjs --api http://127.0.0.1:8788 --seed .e2e-state/seed-output.json [--store SMOKE1] [--tickets 300] [--seconds 300] [--panels 50]
 *
 * 注意：本機 workerd 是單一行程，延遲數字只代表「程式本身沒有瓶頸」，不代表 Cloudflare 邊緣的實際延遲。
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1]?.startsWith("--") ? "1" : arr[i + 1]]] : a), []),
);
const API = args.api ?? "http://127.0.0.1:8788";
const SEED = args.seed ?? ".e2e-state/seed-output.json";
const CODE = args.store ?? "SMOKE1";
const N = Number(args.tickets ?? 300);
const SECONDS = Number(args.seconds ?? 300);
const PANELS = Number(args.panels ?? 50);
const WS = API.replace(/^http/, "ws");
const PHONE_BASE = Number(args.phoneBase ?? 70000000);

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let out = "", bits = 0, v = 0;
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}
const qrToken = (key, storeId, w) => base32(createHmac("sha256", key).update(`${storeId}:${w}`).digest()).slice(0, 10);
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = JSON.parse(readFileSync(SEED, "utf8")).stores.find((s) => s.code === CODE);
if (!store) throw new Error(`seed 找不到門店 ${CODE}`);

function openWs(role, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws/store/${store.id}?role=${role}`, ["qcs.v1", `auth.${token}`]);
    const msgs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      msgs.push(m);
      ws.onmsg?.(m);
    };
    ws.onerror = () => reject(new Error(`${role} WS error`));
    const t = setTimeout(() => reject(new Error(`${role} hello timeout`)), 10_000);
    ws.onopen = () => {
      const wait = setInterval(() => {
        const hello = msgs.find((m) => m.type === "hello");
        if (hello) {
          clearInterval(wait);
          clearTimeout(t);
          resolve({ ws, hello: hello.data, msgs });
        }
      }, 10);
    };
  });
}

async function main() {
  console.log(`壓測：${store.name}（${CODE}）${N} 號／${SECONDS} 秒、面板 ${PANELS} 台，API ${API}`);
  // 1) 面板連線
  const t0 = Date.now();
  const panels = [];
  for (let i = 0; i < PANELS; i += 10) panels.push(...(await Promise.all(Array.from({ length: Math.min(10, PANELS - i) }, () => openWs("display", store.displayToken)))));
  console.log(`• ${panels.length} 台面板連線完成（${Date.now() - t0} ms）`);
  const qr = panels[0].hello.qr;
  const key = Buffer.from(qr.keyB64, "base64");

  // 2) 人員登入＋WS
  const lr = await fetch(`${API}/api/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${store.staffDeviceToken}` },
    body: JSON.stringify({ userId: store.staff[0].id, pin: store.staff[0].pin }),
  });
  if (!lr.ok) throw new Error(`staff login ${lr.status}`);
  const staffTok = (await lr.json()).token;
  const staff = await openWs("staff", staffTok);
  const counters = (await (await fetch(`${API}/api/staff/device`, { headers: { authorization: `Bearer ${store.staffDeviceToken}` } })).json()).counters;

  // 叫號延遲：送出 → 每台面板收到該號 ticket.called，取最後一台
  const pending = new Map(); // number → { t0, got:Set }
  const callLat = [];
  panels.forEach((p, idx) => {
    p.ws.onmsg = (m) => {
      if (m.type !== "ticket.called") return;
      const e = pending.get(m.data.number);
      if (!e) return;
      e.got.add(idx);
      if (e.got.size === panels.length) {
        callLat.push(Date.now() - e.t0);
        pending.delete(m.data.number);
      }
    };
  });
  const acks = new Map();
  staff.ws.onmsg = (m) => {
    if (m.t === "ack") acks.get(m.cmdId)?.(m);
  };
  let cmdN = 0;
  const cmd = (name, a) =>
    new Promise((resolve) => {
      const id = `load_${Date.now()}_${cmdN++}`;
      acks.set(id, resolve);
      staff.ws.send(JSON.stringify({ t: "cmd", cmdId: id, cmd: name, args: a }));
    });

  // 3) 取號（均勻分散在 SECONDS 秒內）＋ 叫號（每取 1 號叫 1 號，模擬尖峰同時廣播）
  const takeLat = [];
  const errors = {};
  const err = (k) => (errors[k] = (errors[k] ?? 0) + 1);
  const svc = (await (await fetch(`${API}/api/s/${CODE}/session?w=${Math.floor(Date.now() / 120000)}&k=${qrToken(key, store.id, Math.floor(Date.now() / 120000))}`)).json()).services?.[0];
  if (!svc) throw new Error("取得服務類別失敗（QR 驗證？）");
  const counter = counters.find((c) => !c.serviceIds.length || c.serviceIds.includes(svc.id)) ?? counters[0];
  const gap = (SECONDS * 1000) / N;
  const tStart = Date.now();
  const takes = [];
  let calls = Promise.resolve();
  for (let i = 0; i < N; i++) {
    const due = tStart + i * gap;
    if (due > Date.now()) await sleep(due - Date.now());
    takes.push(
      (async () => {
        const w = Math.floor(Date.now() / 120000);
        const a = Date.now();
        try {
          const s = await (await fetch(`${API}/api/s/${CODE}/session?w=${w}&k=${qrToken(key, store.id, w)}`)).json();
          const r = await fetch(`${API}/api/s/${CODE}/tickets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: s.sessionToken, serviceId: svc.id, name: `壓測${i}`, phone: "09" + String(PHONE_BASE + i), consent: true }),
          });
          if (!r.ok) return err(`take_${r.status}`);
          takeLat.push(Date.now() - a);
          // 叫號序列化（一個櫃台）：每取一號就叫一號
          calls = calls.then(async () => {
            const sent = Date.now();
            const ack = await cmd("callNext", { counterId: counter.id });
            if (!ack.ok) return err(`call_${ack.error}`);
            pending.set(ack.result.ticket.number, { t0: sent, got: new Set() });
          });
        } catch (e) {
          err(`take_exc`);
        }
      })(),
    );
  }
  await Promise.all(takes);
  await calls;
  await sleep(1500);
  const missing = pending.size;
  for (const p of panels) p.ws.close();
  staff.ws.close();
  const out = {
    store: CODE,
    tickets: N,
    seconds: SECONDS,
    panels: PANELS,
    takeOk: takeLat.length,
    callsMeasured: callLat.length,
    callsMissingOnSomePanel: missing,
    takeMs: { p50: pct(takeLat, 0.5), p95: pct(takeLat, 0.95), max: Math.max(...takeLat) },
    callToAllPanelsMs: { p50: pct(callLat, 0.5), p95: pct(callLat, 0.95), max: Math.max(...callLat) },
    errors,
    wallSec: Math.round((Date.now() - tStart) / 1000),
  };
  console.log(JSON.stringify(out, null, 2));
  const pass = out.callToAllPanelsMs.p95 !== null && out.callToAllPanelsMs.p95 < 1000 && !Object.keys(errors).length && !missing && out.takeOk === N;
  console.log(pass ? "✓ 通過：p95 叫號延遲 < 1 秒、無錯誤" : "✗ 未通過");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

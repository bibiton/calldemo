/**
 * 5.1 壓測（k6，對正式環境；同情境的本機版 local-load.mjs 已實測通過，見 docs/09 M5 實作狀態）。
 * 部署後在 smoke／內部測試門店上跑，不影響真實門店：
 *   k6 run -e API=https://call-api.jjoy.ai -e STORE_ID=... -e STORE_CODE=SMOKE1 \
 *          -e DISPLAY_TOKEN=... -e STAFF_DEVICE_TOKEN=... -e STAFF_ID=... -e STAFF_PIN=... scripts/load/k6-call.js
 * 情境：50 台面板 WS 連線 5 分鐘；5 分鐘內取 300 號（每秒 1 號）；人員每秒叫下一號。
 * 門檻：叫號 → 面板收到（每台各自量）p95 < 1 秒、取號 p95 < 1 秒、錯誤率 < 1%。
 * 權杖只從 -e 帶入，不寫進檔案。未實測（本機沒有 k6、正式環境未部署）。
 */
import http from "k6/http";
import ws from "k6/ws";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";

const API = __ENV.API;
const WS = API.replace(/^http/, "ws");
const callLatency = new Trend("call_to_panel_ms", true);
const takeLatency = new Trend("take_ms", true);
const errors = new Rate("errors");

export const options = {
  scenarios: {
    panels: { executor: "per-vu-iterations", vus: 50, iterations: 1, exec: "panel", maxDuration: "7m" },
    customers: { executor: "constant-arrival-rate", rate: 1, timeUnit: "1s", duration: "5m", preAllocatedVUs: 10, exec: "customer", startTime: "10s" },
    counter: { executor: "per-vu-iterations", vus: 1, iterations: 1, exec: "staff", startTime: "10s", maxDuration: "7m" },
  },
  thresholds: { call_to_panel_ms: ["p(95)<1000"], take_ms: ["p(95)<1000"], errors: ["rate<0.01"] },
};

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let out = "";
  let bits = 0;
  let v = 0;
  for (const b of bytes) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const proto = (token) => ({ headers: { "Sec-WebSocket-Protocol": `qcs.v1, auth.${token}` } });

export function setup() {
  // QR 金鑰取自面板 hello（與真實面板相同路徑）
  let qr = null;
  ws.connect(`${WS}/ws/store/${__ENV.STORE_ID}?role=display`, proto(__ENV.DISPLAY_TOKEN), (s) => {
    s.on("message", (m) => {
      const e = JSON.parse(m);
      if (e.type === "hello") {
        qr = e.data.qr;
        s.close();
      }
    });
    s.setTimeout(() => s.close(), 10000);
  });
  const lr = http.post(`${API}/api/staff/login`, JSON.stringify({ userId: __ENV.STAFF_ID, pin: __ENV.STAFF_PIN }), {
    headers: { "content-type": "application/json", authorization: `Bearer ${__ENV.STAFF_DEVICE_TOKEN}` },
  });
  return { keyB64: qr.keyB64, staffToken: lr.json("token") };
}

export function panel() {
  ws.connect(`${WS}/ws/store/${__ENV.STORE_ID}?role=display`, proto(__ENV.DISPLAY_TOKEN), (s) => {
    s.on("message", (m) => {
      if (m === "pong") return;
      const e = JSON.parse(m);
      // calledAt＝DO 處理叫號的時間；與本機時鐘差異會計入（跑前確認 NTP 校時）
      if (e.type === "ticket.called" && e.data.calledAt) callLatency.add(Date.now() - e.data.calledAt);
    });
    s.setInterval(() => s.send("ping"), 30000); // 與真實面板相同的心跳（auto-response）
    s.setTimeout(() => s.close(), 6 * 60 * 1000);
  });
}

export function customer(data) {
  const w = Math.floor(Date.now() / 120000);
  const mac = new Uint8Array(crypto.hmac("sha256", encoding.b64decode(data.keyB64), `${__ENV.STORE_ID}:${w}`, "binary"));
  const t0 = Date.now();
  const s = http.get(`${API}/api/s/${__ENV.STORE_CODE}/session?w=${w}&k=${base32(mac).slice(0, 10)}`);
  if (!check(s, { session: (r) => r.status === 200 })) return errors.add(1);
  const phone = "09" + String(80000000 + __VU * 1000 + __ITER);
  const r = http.post(
    `${API}/api/s/${__ENV.STORE_CODE}/tickets`,
    JSON.stringify({ session: s.json("sessionToken"), serviceId: s.json("services.0.id"), name: `壓測${__VU}-${__ITER}`, phone, consent: true }),
    { headers: { "content-type": "application/json" } },
  );
  errors.add(r.status !== 200);
  if (r.status === 200) takeLatency.add(Date.now() - t0);
}

export function staff(data) {
  const counters = http.get(`${API}/api/staff/device`, { headers: { authorization: `Bearer ${__ENV.STAFF_DEVICE_TOKEN}` } }).json("counters");
  ws.connect(`${WS}/ws/store/${__ENV.STORE_ID}?role=staff`, proto(data.staffToken), (s) => {
    let n = 0;
    s.setInterval(() => s.send(JSON.stringify({ t: "cmd", cmdId: `k6_${Date.now()}_${n++}`, cmd: "callNext", args: { counterId: counters[0].id } })), 1000);
    s.setTimeout(() => s.close(), 5 * 60 * 1000 + 15000);
  });
}

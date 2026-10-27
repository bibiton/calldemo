#!/usr/bin/env node
/**
 * smoke：正式網址的 WebSocket（docs/08 §4.2 6b）。以 smoke 門店店長登入 → 以店長 access token 連 /ws/store/<id>?role=staff
 * → 必須收到 hello（DO 已接手），送 "ping" 必須收到 "pong"（DO auto-response，hibernation 不喚醒）。
 * 憑證：~/.config/queue-call-system/smoke.json（bootstrap.sh 建立，600；只含 smoke 測試門店的店長帳密，不是 Cloudflare 憑證）。
 * 用法：node scripts/smoke-ws.mjs https://call-api.jjoy.ai
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const api = process.argv[2] ?? "https://call-api.jjoy.ai";
const file = join(homedir(), ".config/queue-call-system/smoke.json");
const fail = (m) => {
  console.error(`✘ ${m}`);
  process.exit(1);
};
if (!existsSync(file)) fail(`找不到 ${file}（請先執行 scripts/bootstrap.sh）`);
if ((statSync(file).mode & 0o077) !== 0) fail(`${file} 權限過寬，請 chmod 600`);
const cfg = JSON.parse(readFileSync(file, "utf8"));

const login = await fetch(`${api}/api/store/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://call-store.jjoy.ai" },
  body: JSON.stringify({ email: cfg.email, password: cfg.password }),
});
if (login.status !== 200) fail(`smoke 店長登入失敗：HTTP ${login.status}`);
const { accessToken: token } = await login.json();

const wsUrl = `${api.replace(/^http/, "ws")}/ws/store/${cfg.storeId}?role=staff`;
const result = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl, ["qcs.v1", `auth.${token}`]);
  const got = { hello: false, pong: false };
  const timer = setTimeout(() => {
    ws.close();
    resolve({ ...got, error: "逾時 10 秒" });
  }, 10_000);
  ws.onerror = () => {
    clearTimeout(timer);
    resolve({ ...got, error: "WebSocket 連線錯誤" });
  };
  ws.onmessage = (e) => {
    const data = String(e.data);
    if (data === "pong") got.pong = true;
    else {
      try {
        const m = JSON.parse(data);
        if (m.t === "evt" && m.type === "hello") {
          got.hello = true;
          ws.send("ping");
        }
      } catch {
        /* 其他訊息略過 */
      }
    }
    if (got.hello && got.pong) {
      clearTimeout(timer);
      ws.close(1000);
      resolve(got);
    }
  };
});
if (!result.hello || !result.pong) fail(`WebSocket smoke 失敗：hello=${result.hello} pong=${result.pong} ${result.error ?? ""}`);
console.log("✔ WebSocket：hello＋ping/pong");

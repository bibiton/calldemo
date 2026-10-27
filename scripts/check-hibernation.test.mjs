import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir, checkSource } from "./check-hibernation.mjs";

const rules = (src) => checkSource(src).map((p) => p.rule);

test("實際 DO 目錄通過", () => {
  const dir = join(fileURLToPath(new URL(".", import.meta.url)), "../apps/api/src/do");
  assert.deepEqual(checkDir(dir), []);
});

test("抓到 setTimeout / setInterval", () => {
  assert.deepEqual(rules("setTimeout(() => {}, 1)"), ["no-setTimeout"]);
  assert.deepEqual(rules("const t = setInterval(f, 30)"), ["no-setInterval"]);
});

test("抓到 ws.accept()，但不誤判 ctx.acceptWebSocket", () => {
  assert.deepEqual(rules("server.accept();"), ["no-ws-accept"]);
  assert.deepEqual(rules("this.ctx.acceptWebSocket(server, tags);"), []);
});

test('抓到 addEventListener("message"', () => {
  assert.deepEqual(rules('ws.addEventListener("message", h)'), ["no-addEventListener-message"]);
  assert.deepEqual(rules("ws.addEventListener('close', h)"), ["no-addEventListener-message"]);
});

test("抓到對外 fetch，但不誤判 async fetch(request) handler 與 stub.fetch", () => {
  assert.deepEqual(rules('await fetch("https://push.example")'), ["no-external-fetch"]);
  assert.deepEqual(rules("async fetch(request: Request) {"), []);
  assert.deepEqual(rules("await stub.fetch(req)"), []);
});

test("註解與字串裡出現不算", () => {
  assert.deepEqual(rules("// 禁止 setTimeout(\n/* setInterval( */\nconst s = 'setTimeout(';"), []);
});

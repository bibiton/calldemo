#!/usr/bin/env node
/**
 * T12：DO 檔案的 Hibernation 規範靜態檢查（04-realtime-protocol §2、ADR-006）。CI 失敗即擋。
 * 掃描 apps/api/src/do/ 底下所有 .ts，去除註解與字串後比對禁用寫法。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "no-setTimeout", re: /\bsetTimeout\s*\(/, why: "DO 內禁止 setTimeout（會阻止 hibernation）；定時工作用 storage.setAlarm()" },
  { id: "no-setInterval", re: /\bsetInterval\s*\(/, why: "DO 內禁止 setInterval（會阻止 hibernation）" },
  { id: "no-ws-accept", re: /\.accept\s*\(\s*\)/, why: "禁止 ws.accept()；只能用 ctx.acceptWebSocket(ws, tags)" },
  { id: "no-addEventListener-message", re: /addEventListener\s*\(\s*["'`](message|close|error)["'`]/, why: "禁止 ws.addEventListener；hibernation 後只有 webSocketMessage/Close/Error handler 會被呼叫" },
  { id: "no-external-fetch", re: /(?<![.\w])fetch\s*\(\s*(?!request\b)/, why: "DO 內禁止對外 fetch（等待期間計 duration）；外部呼叫走 Queues" },
];

/** 去掉註解與字串內容（保留換行以維持行號）。 */
export function stripCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) out += src[i++] === "\n" ? "\n" : "";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += q;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") out += "\n";
        i++;
      }
      out += q;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function checkSource(src, file = "<src>") {
  const code = stripCode(src);
  // 字串被清空，但 addEventListener("message" 的判斷需要保留引號內容 → 對原始碼另外比對（去註解版）
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/\/\/.*$/gm, "");
  const problems = [];
  const lines = code.split("\n");
  const rawLines = noComments.split("\n");
  for (const r of RULES) {
    const target = r.id === "no-addEventListener-message" ? rawLines : lines;
    target.forEach((line, idx) => {
      if (r.re.test(line)) problems.push({ file, line: idx + 1, rule: r.id, why: r.why, text: rawLines[idx].trim() });
    });
  }
  return problems;
}

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

export function checkDir(dir) {
  return walk(dir).flatMap((f) => checkSource(readFileSync(f, "utf8"), f));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dir = join(root, "apps/api/src/do");
  const problems = checkDir(dir);
  if (problems.length) {
    console.error("✗ Hibernation 規範檢查失敗（T12）：");
    for (const p of problems) console.error(`  ${relative(root, p.file)}:${p.line}  [${p.rule}] ${p.why}\n    > ${p.text}`);
    process.exit(1);
  }
  console.log(`✓ Hibernation 規範檢查通過（${walk(dir).length} 個 DO 檔案）`);
}

#!/usr/bin/env node
/**
 * 5.3 無硬編碼密鑰：掃描 git 追蹤的檔案，找出看起來像真實密鑰的字串。CI／pnpm test 失敗即擋。
 * 範例檔（*.example*）只能有空值或 change-me；測試用的假值須明顯（test-/fake/dummy）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const RULES = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "bearer-literal", re: /Bearer\s+[A-Za-z0-9_\-]{40,}/ },
  // KEY=value 形式：JWT／PEPPER／QR／VAPID／Cloudflare token 等真值（值長且不是佔位字）
  {
    id: "env-secret",
    re: /\b(JWT_SECRET|PHONE_PEPPER|QR_ROOT_SECRET|VAPID_PRIVATE_KEY|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|AE_API_TOKEN|ADMIN_INIT_PASSWORD)\s*[=:]\s*["']?(?!change-me|test-|<|\$|\{|fake|dummy|xxx|\s|$|["'])[A-Za-z0-9+/_=\-]{16,}/,
  },
];

const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|webp|mp4|mp3|ogg|wav|woff2?|ico)$/i, /^assets\/audio\//, /^test-results\//];

export function scan(text, file = "<text>") {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const r of RULES) if (r.re.test(line)) out.push({ file, line: i + 1, rule: r.id });
  });
  return out;
}

function main() {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
  const problems = [];
  for (const f of files) {
    let t;
    try {
      t = readFileSync(resolve(root, f), "utf8");
    } catch {
      continue;
    }
    problems.push(...scan(t, f));
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p.file}:${p.line}  疑似密鑰（${p.rule}）`);
    process.exit(1);
  }
  console.log(`✓ 密鑰掃描通過（${files.length} 個 git 追蹤檔案）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

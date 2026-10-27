#!/usr/bin/env node
/**
 * Demo 資料包（13-demo-seed、roadmap M7 7.3）：虛構品牌「鮮迴壽司」3 家 DEMO 門店＋廣告素材（assets/demo）。
 *
 * 用法（在 repo 根目錄）：
 *   pnpm seed:demo                                   本機（wrangler dev 的本機 D1／R2／KV）
 *   pnpm seed:demo --env production --confirm        正式環境（ADR-049 只有一套）：只動下列 DEMOSK* 門店
 *   pnpm seed:demo [--env production --confirm] --reset   刪除 DEMO 門店的全部資料列與 R2 素材
 *   選項：--persist-to <dir>（本機）、--skip-media（不重傳 R2）
 *
 * 安全：
 *   - 只寫入固定的 DEMO_STORES（id st_sk_*、門店碼 DEMOSK*、features.demo=true）與 brand_demo；正式環境寫入前先檢查
 *     同 id／同門店碼的既有門店必須就是本腳本建立的 DEMO 門店（features.demo=true 且 id／碼成對），否則中止。
 *   - 正式環境憑證只讀 ~/.config/queue-call-system/cf.env（權限須 600），wrangler 以暫存 HOME＋環境變數 token 執行，
 *     不用全域 wrangler login；不印出 token。
 *   - 冪等：UPSERT（不用 INSERT OR REPLACE——D1 外鍵沒有 CASCADE，REPLACE 會刪父列）；密碼／PIN／裝置 token 首次產生後存在輸出檔，重跑沿用。
 *
 * 輸出（含門店後台密碼、人員 PIN、面板／人員手機 token）：
 *   本機 apps/api/.wrangler/demo-output.json；正式環境 ~/.config/queue-call-system/demo-output.json（600，不在 repo）。
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const root = resolve(apiDir, "../..");
const demoDir = join(root, "assets/demo");
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n) => args.includes(n);
const die = (m) => {
  console.error(`✘ ${m}`);
  process.exit(1);
};

const ENV = opt("--env") ?? "local";
if (!["local", "production"].includes(ENV)) die(`--env 只能是 local 或 production（ADR-049 沒有 staging）：${ENV}`);
const PROD = ENV === "production";
if (PROD && !has("--confirm")) die("正式環境必須加 --confirm（只會動 DEMOSK* 門店）");
const RESET = has("--reset");

// ---------- 固定的 DEMO 範圍（安全邊界：只會讀寫這些 id） ----------
export const BRAND = { id: "brand_demo", name: "鮮迴壽司" };
const H = (open, close) => [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, open, close }));
export const DEMO_STORES = [
  {
    id: "st_sk_zs", code: "DEMOSK01", name: "鮮迴壽司 台北中山店", key: "zs", simulate: true,
    counters: [[1, "A"], [2, "A"], [3, "B"]],
    staff: ["林小芸", "張阿翔"],
  },
  {
    id: "st_sk_gy", code: "DEMOSK02", name: "鮮迴壽司 台中公益店", key: "gy", simulate: false,
    counters: [[1, "A"], [2, "B"]],
    staff: ["陳美玲", "黃建宏"],
  },
  {
    id: "st_sk_zy", code: "DEMOSK03", name: "鮮迴壽司 高雄左營店", key: "zy", simulate: false,
    counters: [[1, "A"], [2, "B"]],
    staff: ["吳佳穎", "蔡志明"],
  },
];
for (const s of DEMO_STORES) {
  if (!/^st_sk_[a-z]+$/.test(s.id) || !/^DEMOSK\d\d$/.test(s.code)) die(`DEMO 門店定義不合規則：${s.id} ${s.code}`);
}
const HOURS = H("10:00", "22:00"); // 模擬叫號只在營業時間內（DO 判斷）
const VOICE = { mode: "fun", funPrefixProb: 0.5, venue: "food", enabledPacks: ["hungry", "anticipation", "warm"], repeat: 2, volume: 0.8 };

const HOSTS = {
  api: PROD ? "https://call-api.jjoy.ai" : "http://127.0.0.1:8787",
  display: PROD ? "https://call-display.jjoy.ai" : "http://localhost:5174",
  staff: PROD ? "https://call-staff.jjoy.ai" : "http://localhost:5173",
  store: PROD ? "https://call-store.jjoy.ai" : "http://localhost:5172",
};
const DB = PROD ? "call-db-production" : "qcs-db-local";
const BUCKET = PROD ? "call-media-production" : "qcs-media-local";
const outFile = PROD ? join(homedir(), ".config/queue-call-system/demo-output.json") : join(apiDir, ".wrangler/demo-output.json");

// ---------- wrangler（正式環境：隔離 HOME、token 只從環境變數） ----------
const wranglerBin = join(apiDir, "node_modules/.bin/wrangler");
let wEnv = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
let tmpHome = null;
if (PROD) {
  const f = join(homedir(), ".config/queue-call-system/cf.env");
  if (!existsSync(f)) die(`找不到 ${f}`);
  if ((statSync(f).mode & 0o077) !== 0) die(`${f} 權限過寬，請 chmod 600`);
  const cf = Object.fromEntries(
    readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
  );
  if (!cf.CLOUDFLARE_API_TOKEN || !/^[0-9a-f]{32}$/.test(cf.CLOUDFLARE_ACCOUNT_ID ?? "")) die("cf.env 缺 CLOUDFLARE_API_TOKEN／CLOUDFLARE_ACCOUNT_ID");
  tmpHome = mkdtempSync(join(tmpdir(), "call-seed-"));
  const { CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL, ...rest } = wEnv;
  wEnv = { ...rest, CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID, HOME: tmpHome, XDG_CONFIG_HOME: join(tmpHome, "config") };
  process.on("exit", () => rmSync(tmpHome, { recursive: true, force: true }));
  if (/__[A-Z0-9]+_ID_PRODUCTION__/.test(readFileSync(join(apiDir, "wrangler.toml"), "utf8"))) die("wrangler.toml 仍有佔位 id：請先執行 scripts/bootstrap.sh");
}
const target = PROD ? ["--remote", "--env", "production"] : ["--local", "--env", "local", ...(opt("--persist-to") ? ["--persist-to", resolve(opt("--persist-to"))] : [])];
const wrangler = (a, { quiet = true } = {}) =>
  execFileSync(wranglerBin, a, { cwd: apiDir, env: wEnv, stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"], maxBuffer: 64 << 20 }).toString();
const d1json = (sql) => {
  const out = wrangler(["d1", "execute", DB, ...target, "--json", "--command", sql]);
  return JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [];
};
const d1file = (stmts) => {
  const f = join(apiDir, ".wrangler", `seed-demo-${ENV}.sql`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, stmts.join("\n") + "\n");
  wrangler(["d1", "execute", DB, ...target, "--file", f, ...(PROD ? ["-y"] : [])]);
};

// ---------- SQL 工具 ----------
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
/** UPSERT：衝突時更新除了 keep 以外的欄位 */
const upsert = (table, obj, pk = ["id"], keep = ["created_at"]) => {
  const cols = Object.keys(obj);
  const sets = cols.filter((c) => !pk.includes(c) && !keep.includes(c)).map((c) => `${c}=excluded.${c}`);
  return `INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map((c) => q(obj[c])).join(",")}) ON CONFLICT(${pk.join(",")}) DO ${sets.length ? `UPDATE SET ${sets.join(",")}` : "NOTHING"};`;
};
const ids = DEMO_STORES.map((s) => q(s.id)).join(",");

// ---------- 先前輸出（沿用密碼／PIN／token） ----------
const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : { stores: [] };
const prevStore = (id) => prev.stores?.find((s) => s.id === id) ?? {};

// ---------- 正式環境安全檢查 ----------
if (PROD) {
  const codes = DEMO_STORES.map((s) => q(s.code)).join(",");
  const rows = d1json(`SELECT id, code, features FROM stores WHERE id IN (${ids}) OR code IN (${codes})`);
  for (const r of rows) {
    const s = DEMO_STORES.find((x) => x.id === r.id);
    let f = {};
    try { f = JSON.parse(r.features); } catch { /* 視為非 demo */ }
    if (!s || s.code !== r.code || f.demo !== true) die(`安全檢查：既有門店 ${r.id}／${r.code} 不是本腳本的 DEMO 門店，拒絕寫入`);
  }
  console.log(`• 正式環境安全檢查通過（既有 DEMO 門店 ${rows.length} 家）`);
}

const TABLES_BY_STORE = ["counters", "services", "devices", "pairings", "tickets_history", "daily_stats", "audit_logs", "push_subscriptions", "transfer_codes", "pin_failures", "usage_hourly", "usage_daily", "usage_monthly"];

if (RESET) {
  const prevKeys = d1json(`SELECT r2_key FROM ad_assets WHERE owner_type='store' AND owner_id IN (${ids})`).map((r) => r.r2_key);
  const logoKeys = d1json(`SELECT logo_r2_key AS k FROM stores WHERE id IN (${ids}) AND logo_r2_key IS NOT NULL`).map((r) => r.k);
  const sql = [
    `DELETE FROM ad_playlist_items WHERE playlist_id IN (SELECT id FROM ad_playlists WHERE owner_type='store' AND owner_id IN (${ids}));`,
    `DELETE FROM ad_playlists WHERE owner_type='store' AND owner_id IN (${ids});`,
    `DELETE FROM ad_assets WHERE owner_type='store' AND owner_id IN (${ids});`,
    `DELETE FROM users WHERE store_id IN (${ids});`,
    ...TABLES_BY_STORE.map((t) => `DELETE FROM ${t} WHERE store_id IN (${ids});`),
    `DELETE FROM stores WHERE id IN (${ids});`,
    `DELETE FROM brands WHERE id='${BRAND.id}' AND NOT EXISTS (SELECT 1 FROM stores WHERE brand_id='${BRAND.id}');`,
  ];
  d1file(sql);
  for (const k of new Set([...prevKeys, ...logoKeys])) {
    if (!/^(ads\/st_sk_|logos\/brand_demo\/)/.test(k)) continue; // 只刪 DEMO 範圍
    try { wrangler(["r2", "object", "delete", `${BUCKET}/${k}`, ...target]); } catch { /* 已不存在 */ }
  }
  for (const s of DEMO_STORES) kvDelete(s);
  if (existsSync(outFile)) rmSync(outFile);
  console.log(`✓ 已刪除 ${DEMO_STORES.length} 家 DEMO 門店的資料列與 R2 素材（${ENV}）`);
  process.exit(0);
}

// ---------- 素材 ----------
const manifestFile = join(demoDir, "manifest.json");
if (!existsSync(manifestFile)) die("找不到 assets/demo/manifest.json（Demo 素材包）");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const media = manifest.assets.map((a, i) => {
  const buf = readFileSync(join(demoDir, a.file));
  const ext = a.file.split(".").pop().toLowerCase();
  return { ...a, i, ext, buf, sha: sha(buf), bytes: buf.length };
});
const logoBuf = readFileSync(join(demoDir, manifest.logo.png));
const logoKey = `logos/${BRAND.id}/${sha(logoBuf)}.png`;

// ---------- 密碼與雜湊（與 apps/api/src/lib/password.ts 相同格式） ----------
const hash = (secret) => {
  const salt = randomBytes(16);
  return `pbkdf2$sha256$100000$${salt.toString("base64")}$${pbkdf2Sync(secret, salt, 100_000, 32, "sha256").toString("base64")}`;
};
const genPassword = () => randomBytes(9).toString("base64url");
const genPin = (used) => {
  for (;;) {
    const p = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!used.has(p) && !/^(\d)\1{5}$/.test(p)) return used.add(p), p;
  }
};

const now = Date.now();
const sql = [];
const out = { env: ENV, generatedAt: new Date(now).toISOString(), stores: [] };

sql.push(upsert("brands", { id: BRAND.id, name: BRAND.name, ads_push_enabled: 0, created_at: now, updated_at: now }));

for (const s of DEMO_STORES) {
  const p = prevStore(s.id);
  const adminEmail = `senkai-${s.key}@example.com`;
  const adminPassword = p.adminPassword ?? genPassword();
  const used = new Set();
  const staff = s.staff.map((name, i) => {
    const old = p.staff?.find((x) => x.id === `${s.id}_staff${i + 1}`);
    const pin = old?.pin ?? genPin(used);
    used.add(pin);
    return { id: `${s.id}_staff${i + 1}`, name, pin };
  });
  sql.push(
    upsert("stores", {
      id: s.id, brand_id: BRAND.id, code: s.code, name: s.name, status: "active", expires_at: null, max_devices: 3, max_staff: 10,
      ad_quota_bytes: 524288000,
      features: JSON.stringify({ push: true, ads: true, voice: true, showMaskedName: true, demo: true, demoSimulate: s.simulate }),
      timezone: "Asia/Taipei", business_hours: JSON.stringify(HOURS), qr_key_version: 1, voice_settings: JSON.stringify(VOICE),
      logo_r2_key: logoKey, notify_ahead: 3, deleted_at: null, created_at: now, updated_at: now,
    }, ["id"], ["created_at", "qr_key_version"]),
  );
  sql.push(upsert("services", { id: `${s.id}_A`, store_id: s.id, name: "內用", prefix: "A", sort_order: 1, enabled: 1, daily_limit: null, created_at: now }));
  sql.push(upsert("services", { id: `${s.id}_B`, store_id: s.id, name: "外帶", prefix: "B", sort_order: 2, enabled: 1, daily_limit: null, created_at: now }));
  for (const [n, pre] of s.counters) {
    sql.push(upsert("counters", { id: `${s.id}_c${n}`, store_id: s.id, name: `${n} 號櫃台`, number: n, service_ids: JSON.stringify([`${s.id}_${pre}`]), enabled: 1, created_at: now }));
  }
  const userBase = { status: "active", failed_attempts: 0, locked_until: null, created_at: now, updated_at: now };
  sql.push(upsert("users", { id: `${s.id}_admin`, role: "store_admin", store_id: s.id, display_name: "店長", email: adminEmail, password_hash: hash(adminPassword), pin_hash: null, ...userBase }, ["id"], ["created_at", "token_version"]));
  for (const u of staff) {
    sql.push(upsert("users", { id: u.id, role: "staff", store_id: s.id, display_name: u.name, email: null, password_hash: null, pin_hash: hash(u.pin), ...userBase }, ["id"], ["created_at", "token_version"]));
  }

  // 廣告：每店自己的播放清單（manifest 只讀門店層），R2 key 與上傳相同的內容定址格式 ads/<store>/<sha256>.<ext>
  const pl = `${s.id}_pl`;
  sql.push(`INSERT INTO ad_playlists(id,owner_type,owner_id,version,accept_brand,updated_at) VALUES(${q(pl)},'store',${q(s.id)},1,1,${now}) ON CONFLICT(id) DO UPDATE SET version=version+1, updated_at=excluded.updated_at;`);
  const itemIds = [];
  for (const m of media) {
    const assetId = `${s.id}_${m.sha.slice(0, 16)}`;
    const itemId = `${s.id}_it_${m.sha.slice(0, 16)}`;
    itemIds.push(itemId);
    sql.push(upsert("ad_assets", {
      id: assetId, owner_type: "store", owner_id: s.id, kind: m.kind, r2_key: `ads/${s.id}/${m.sha}.${m.ext}`, sha256: m.sha, mime: m.mime, bytes: m.bytes,
      width: m.width, height: m.height, duration_ms: m.kind === "video" ? m.durationMs : null, status: "ready", created_by: null, created_at: now, name: m.title,
    }));
    sql.push(upsert("ad_playlist_items", {
      id: itemId, playlist_id: pl, asset_id: assetId, sort_order: m.i, duration_ms: m.kind === "image" ? (m.durationMs ?? 6000) : null,
      active_from: null, active_to: null, active_dows: "[0,1,2,3,4,5,6]", start_date: null, end_date: null, enabled: 1, show_on_customer: m.showOnCustomer && m.kind === "image" ? 1 : 0,
    }));
  }
  sql.push(`DELETE FROM ad_playlist_items WHERE playlist_id=${q(pl)} AND id NOT IN (${itemIds.map(q).join(",")});`);
  if (s.key === "zs") sql.push(...demoHistory(s.id));
  out.stores.push({ id: s.id, code: s.code, name: s.name, simulate: s.simulate, adminEmail, adminPassword, staff, devices: p.devices ?? {} });
}

d1file(sql);
console.log(`✓ D1：品牌、${DEMO_STORES.length} 家 DEMO 門店、服務、櫃台、帳號、廣告清單（${sql.length} 句）`);

// ---------- R2 ----------
if (!has("--skip-media")) {
  const put = (key, file, mime) =>
    wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", mime, "--cache-control", "public, max-age=31536000, immutable", ...target]);
  put(logoKey, join(demoDir, manifest.logo.png), "image/png");
  for (const s of DEMO_STORES) for (const m of media) put(`ads/${s.id}/${m.sha}.${m.ext}`, join(demoDir, m.file), m.mime);
  console.log(`✓ R2：Logo＋${media.length} 個素材 × ${DEMO_STORES.length} 店 → ${BUCKET}`);
}

// ---------- KV：清掉門店快取（下一次請求由 D1 重建；isolate 記憶體快取最多 60 秒） ----------
function kvDelete(s) {
  for (const k of [`license:${s.id}`, `storecode:${s.code}`]) {
    try { wrangler(["kv", "key", "delete", k, "--binding", "LICENSE", ...target]); } catch { /* 不存在 */ }
  }
}
for (const s of DEMO_STORES) kvDelete(s);
console.log("✓ KV：門店快取已清除");

// ---------- 裝置：面板＋人員手機 ----------
for (const o of out.stores) o.devices = PROD ? await pairProd(o) : localDevices(o);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2));
chmodSync(outFile, 0o600);

console.log(`\n✓ Demo 資料包完成（${ENV}）\n`);
for (const o of out.stores) {
  console.log(`【${o.name}】門店碼 ${o.code}${o.simulate ? "（模擬叫號：開）" : ""}`);
  console.log(`  面板：${HOSTS.display}/?token=…（完整網址見輸出檔）`);
  console.log(`  人員：${HOSTS.staff}/?device=…  PIN：${o.staff.map((u) => `${u.name} ${u.pin}`).join("、")}`);
  console.log(`  門店後台：${HOSTS.store}/  ${o.adminEmail} ／ 密碼見輸出檔\n`);
}
console.log(`（完整輸出含密碼與裝置網址：${outFile}，權限 600，不要上傳）`);

// ===================================================================

function localDevices(o) {
  const vars = Object.fromEntries(
    readFileSync(join(apiDir, ".dev.vars"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  if (!vars.JWT_SECRET) die("apps/api/.dev.vars 沒有 JWT_SECRET：請先跑 pnpm dev:seed");
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const jwt = (claims) => {
    const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64u(JSON.stringify(claims));
    return `${h}.${p}.${createHmac("sha256", vars.JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`;
  };
  const exp = Math.floor(now / 1000) + 365 * 86400;
  const rows = [
    upsert("devices", { id: `${o.id}_d1`, store_id: o.id, kind: "display", name: "叫號面板 1", status: "active", token_version: 1, created_at: now }, ["id"], ["created_at", "token_version"]),
    upsert("devices", { id: `${o.id}_sd1`, store_id: o.id, kind: "staff_device", name: "櫃台手機 1", status: "active", token_version: 1, created_at: now }, ["id"], ["created_at", "token_version"]),
  ];
  d1file(rows);
  const tv = d1json(`SELECT id, token_version FROM devices WHERE id IN ('${o.id}_d1','${o.id}_sd1')`);
  const v = (id) => tv.find((r) => r.id === id)?.token_version ?? 1;
  const displayToken = jwt({ sub: `${o.id}_d1`, role: "display", store_id: o.id, tv: v(`${o.id}_d1`), exp });
  const staffDeviceToken = jwt({ sub: `${o.id}_sd1`, role: "staff_device", store_id: o.id, tv: v(`${o.id}_sd1`), exp });
  return { displayToken, staffDeviceToken, displayUrl: `${HOSTS.display}/?token=${displayToken}`, staffUrl: `${HOSTS.staff}/?device=${staffDeviceToken}` };
}

/** 正式環境：走真實 API 配對（JWT_SECRET 只存在 Worker secret，本機簽不出 token）。已有且仍有效的 token 沿用。 */
async function pairProd(o) {
  const api = async (path, init = {}) => {
    const r = await fetch(`${HOSTS.api}${path}`, { ...init, headers: { "content-type": "application/json", origin: HOSTS.store, ...(init.headers ?? {}) } });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  };
  const old = o.devices ?? {};
  const okDisplay = old.displayToken && (await api("/api/display/ads/manifest", { headers: { authorization: `Bearer ${old.displayToken}` } })).status === 200;
  const okStaff = old.staffDeviceToken && (await api("/api/staff/device", { headers: { authorization: `Bearer ${old.staffDeviceToken}` } })).status === 200;
  if (okDisplay && okStaff) return old;

  const login = await api("/api/store/auth/login", { method: "POST", body: JSON.stringify({ email: o.adminEmail, password: o.adminPassword }) });
  if (login.status !== 200) die(`${o.name} 店長登入失敗（${login.status} ${login.body?.error ?? ""}）`);
  const auth = { authorization: `Bearer ${login.body.accessToken}` };
  const pair = async (seg, name) => {
    const st = await api(`/api/${seg}/pair/start`, { method: "POST", body: "{}" });
    if (st.status !== 200) die(`${seg} pair/start 失敗 ${st.status}`);
    const pr = await api("/api/store/devices/pair", { method: "POST", headers: auth, body: JSON.stringify({ code: st.body.code, name }) });
    if (pr.status !== 200) die(`${o.name} 配對 ${seg} 失敗（${pr.status} ${pr.body?.error ?? ""}）`);
    const fin = await api(`/api/${seg}/pair/status?code=${st.body.code}&secret=${st.body.pollSecret}`);
    if (fin.body?.status !== "paired") die(`${seg} 領取 token 失敗 ${fin.status}`);
    return fin.body.token;
  };
  const displayToken = okDisplay ? old.displayToken : await pair("display", "DEMO 面板");
  const staffDeviceToken = okStaff ? old.staffDeviceToken : await pair("staff", "DEMO 櫃台手機");
  return { displayToken, staffDeviceToken, displayUrl: `${HOSTS.display}/?token=${displayToken}`, staffUrl: `${HOSTS.staff}/?device=${staffDeviceToken}` };
}

/** 報表頁示範：前 7 天歷史（只有遮罩姓名，無手機），固定亂數種子。 */
function demoHistory(storeId) {
  let x = 20261027;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const names = ["林○芸", "張○翔", "陳○玲", "黃○宏", "吳○穎", "蔡○明", "王○婷", "李○豪"];
  const res = [];
  const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(ms);
  for (let d = 7; d >= 1; d--) {
    const bd = ymd(now - d * 86400_000);
    const base = Date.parse(`${bd}T11:00:00+08:00`);
    for (const [svc, count] of [["A", 22 + Math.floor(rnd() * 16)], ["B", 8 + Math.floor(rnd() * 8)]]) {
      for (let i = 1; i <= count; i++) {
        const created = base + Math.floor(rnd() * 9 * 3600_000) + (rnd() < 0.4 ? 1.2 * 3600_000 : 0);
        const r = rnd();
        const status = r < 0.84 ? "done" : r < 0.91 ? "skipped" : r < 0.96 ? "no_show" : "cancelled";
        const called = status === "cancelled" ? null : created + Math.floor((2 + rnd() * 18) * 60_000);
        const serving = status === "done" ? called + 30_000 : null;
        const ended = status === "done" ? serving + Math.floor((3 + rnd() * 6) * 60_000) : (called ?? created) + 5 * 60_000;
        res.push(upsert("tickets_history", {
          id: `${storeId}_h_${bd}_${svc}_${i}`, store_id: storeId, business_date: bd, service_id: `${storeId}_${svc}`,
          number: `${svc}${String(i).padStart(3, "0")}`, final_status: status, name_masked: names[i % names.length], phone_hmac: null, phone_masked: null,
          counter_id: `${storeId}_c${svc === "A" ? 1 : 3}`, staff_id: null, recall_count: 0, transfer_count: 0,
          created_at: created, called_at: called, serving_at: serving, ended_at: ended, source: "qr",
        }, ["id"], []));
      }
    }
  }
  return res;
}

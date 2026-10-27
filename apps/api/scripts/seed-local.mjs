#!/usr/bin/env node
/**
 * 本機 seed（11-local-testing §2）：套用 migration → 灌入 1 品牌、2 門店（＋smoke 門店）、各 2 服務、3 櫃台、
 * 店長＋3 位人員、已配對面板與人員手機、10 筆佔位廣告。只允許本機（--local），拒絕任何遠端環境。
 *
 * 用法：node scripts/seed-local.mjs [--persist-to <dir>] [--out <json>]
 * 冪等：INSERT OR REPLACE，重跑會覆蓋 demo 資料。
 */
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--remote") || args.some((a) => /production|staging/.test(a))) {
  console.error("✗ seed-local 只能用於本機");
  process.exit(1);
}
const persistTo = opt("--persist-to");
const outFile = resolve(opt("--out") ?? join(apiDir, ".wrangler/seed-output.json"));

// 1) .dev.vars：沒有就產生隨機 secrets（不進 git）
const devVars = join(apiDir, ".dev.vars");
if (!existsSync(devVars)) {
  const r = () => randomBytes(36).toString("base64");
  writeFileSync(devVars, `JWT_SECRET=${r()}\nPHONE_PEPPER=${r()}\nQR_ROOT_SECRET=${r()}\n`);
  console.log("• 已產生 apps/api/.dev.vars（隨機本機 secrets）");
}
// VAPID（Web Push，07 §4）：舊的 .dev.vars 沒有就補上，不覆蓋既有值
if (!/^VAPID_PRIVATE_KEY=/m.test(readFileSync(devVars, "utf8"))) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]).toString("base64url");
  const cur = readFileSync(devVars, "utf8");
  writeFileSync(devVars, `${cur.endsWith("\n") ? cur : cur + "\n"}VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${j.d}\nVAPID_SUBJECT=mailto:dev@example.com\n`);
  console.log("• 已在 apps/api/.dev.vars 補上本機 VAPID 金鑰");
}
const vars = Object.fromEntries(
  readFileSync(devVars, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const b64u = (b) => Buffer.from(b).toString("base64url");
const jwt = (claims) => {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${createHmac("sha256", vars.JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`;
};
const hash = (secret) => {
  const salt = randomBytes(16);
  const h = pbkdf2Sync(secret, salt, 100_000, 32, "sha256");
  return `pbkdf2$sha256$100000$${salt.toString("base64")}$${h.toString("base64")}`;
};
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, obj) => `INSERT OR REPLACE INTO ${table}(${Object.keys(obj).join(",")}) VALUES(${Object.values(obj).map(q).join(",")});`;

const now = Date.now();
const YEAR = 365 * 24 * 3600;
const sql = [];
const out = { stores: [] };

sql.push(row("brands", { id: "brand_default", name: "預設品牌", ads_push_enabled: 0, created_at: now, updated_at: now }));

const stores = [
  { id: "st_demo_zs", code: "DEMO01", name: "示範門市 中山店", hours: [], voice: { mode: "fun", funPrefixProb: 0.5, venue: "food" } },
  {
    id: "st_demo_xy",
    code: "DEMO02",
    name: "示範門市 信義店",
    hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, open: "11:00", close: "21:30" })),
    voice: { mode: "standard" },
  },
  { id: "st_smoke", code: "SMOKE1", name: "smoke 測試門店", hours: [], voice: {}, internal: true },
  // 總後台各狀態（M4）：停用、到期、廣告容量將滿＋面板無法出聲
  { id: "st_demo_bq", code: "DEMO03", name: "示範門市 板橋店", hours: [], voice: {}, status: "suspended" },
  { id: "st_demo_ty", code: "DEMO05", name: "示範門市 桃園店", hours: [], voice: {}, expired: true },
  { id: "st_demo_xz", code: "DEMO04", name: "示範門市 新莊店", hours: [], voice: {}, adBytes: 48_000_000, mutedPanel: true },
  // 空門店：門店後台各頁「空狀態」的畫面（沒有櫃台、人員、裝置、廣告、歷史）
  { id: "st_empty", code: "EMPTY1", name: "新開幕測試店", hours: [], voice: {}, empty: true },
];
const staffNames = [
  ["王店員", "111111"],
  ["林店員", "222222"],
  ["陳店員", "333333"],
];

for (const s of stores) {
  sql.push(
    row("stores", {
      id: s.id,
      brand_id: "brand_default",
      code: s.code,
      name: s.name,
      status: s.status ?? "active",
      expires_at: s.expired ? now - 2 * 86400_000 : s.id === "st_demo_zs" ? now + 200 * 86400_000 : null,
      max_devices: 2,
      max_staff: 10,
      ad_quota_bytes: 524288000,
      features: JSON.stringify({ push: true, ads: true, voice: true, showMaskedName: false, demo: true, ...(s.internal ? { internal: true } : {}) }),
      timezone: "Asia/Taipei",
      business_hours: JSON.stringify(s.hours),
      qr_key_version: 1,
      voice_settings: JSON.stringify(s.voice),
      logo_r2_key: s.id === "st_demo_zs" ? "demo-ads/logo.svg" : null, // 顧客頁頁首 Logo（ADR-048）
      created_at: now,
      updated_at: now,
    }),
  );
  sql.push(row("services", { id: `${s.id}_A`, store_id: s.id, name: "內用", prefix: "A", sort_order: 1, enabled: 1, daily_limit: null, created_at: now }));
  sql.push(row("services", { id: `${s.id}_B`, store_id: s.id, name: "外帶", prefix: "B", sort_order: 2, enabled: 1, daily_limit: null, created_at: now }));
  sql.push(row("users", {
    id: `${s.id}_admin`, role: "store_admin", store_id: s.id, display_name: "店長", email: `demo-${s.code.toLowerCase()}@example.com`,
    password_hash: hash("demo-password"), pin_hash: null, status: "active", failed_attempts: 0, locked_until: null, token_version: 1, created_at: now, updated_at: now,
  }));
  if (s.empty) {
    out.stores.push({ id: s.id, code: s.code, name: s.name, adminEmail: `demo-${s.code.toLowerCase()}@example.com`, adminPassword: "demo-password", staff: [] });
    continue;
  }
  [
    [1, [`${s.id}_A`]],
    [2, [`${s.id}_A`]],
    [3, [`${s.id}_B`]],
  ].forEach(([n, svc]) =>
    sql.push(row("counters", { id: `${s.id}_c${n}`, store_id: s.id, name: `${n} 號櫃台`, number: n, service_ids: JSON.stringify(svc), enabled: 1, created_at: now })),
  );
  staffNames.forEach(([name, pin], i) =>
    sql.push(
      row("users", {
        id: `${s.id}_staff${i + 1}`,
        role: "staff",
        store_id: s.id,
        display_name: name,
        email: null,
        password_hash: null,
        pin_hash: hash(pin),
        status: "active",
        failed_attempts: 0,
        locked_until: null,
        token_version: 1,
        created_at: now,
        updated_at: now,
      }),
    ),
  );
  const dev = (id, kind, name) =>
    row("devices", {
      id, store_id: s.id, kind, name, pairing_code: null, pairing_expires_at: null, token_version: 1, counter_id: null, last_seen_at: null,
      client_kind: s.mutedPanel && kind === "display" ? "browser" : null,
      audio_status: s.mutedPanel && kind === "display" ? "blocked" : null,
      audio_status_at: s.mutedPanel && kind === "display" ? now - 12 * 60_000 : null,
      status: "active", created_at: now,
    });
  sql.push(dev(`${s.id}_d1`, "display", "叫號面板 1"));
  sql.push(dev(`${s.id}_sd1`, "staff_device", "櫃台手機 1"));
  const exp = Math.floor(now / 1000) + YEAR;
  const displayToken = jwt({ sub: `${s.id}_d1`, role: "display", store_id: s.id, tv: 1, exp });
  const staffDeviceToken = jwt({ sub: `${s.id}_sd1`, role: "staff_device", store_id: s.id, tv: 1, exp });

  // 佔位廣告（apps/display/public/demo-ads；本機 MEDIA_BASE 指向 display 自己）
  // 影片放第 2 張：E2E 與現場都能很快看到「叫號時影片靜音暫停」
  const imgs = Array.from({ length: 9 }, (_, i) => [`ad${i + 1}.svg`, "image", "image/svg+xml"]);
  const assets = [imgs[0], ["ad-video.mp4", "video", "video/mp4"], ...imgs.slice(1)];
  sql.push(row("ad_playlists", { id: `${s.id}_pl`, owner_type: "store", owner_id: s.id, version: 1, accept_brand: 1, updated_at: now }));
  assets.forEach(([file, kind, mime], i) => {
    const id = `${s.id}_ad${i + 1}`;
    sql.push(row("ad_assets", { id, owner_type: "store", owner_id: s.id, kind, r2_key: `demo-ads/${file}`, sha256: `demo-${file}`, mime, bytes: s.adBytes ?? 1000, width: 1080, height: 720, duration_ms: kind === "video" ? 8000 : null, status: "ready", created_by: null, created_at: now }));
    // 中山店前 3 張圖片「顯示於顧客手機」（ADR-048）
    const onCustomer = s.id === "st_demo_zs" && kind === "image" && ["ad1.svg", "ad2.svg", "ad3.svg"].includes(file) ? 1 : 0;
    sql.push(row("ad_playlist_items", { id: `${s.id}_it${i + 1}`, playlist_id: `${s.id}_pl`, asset_id: id, sort_order: i, duration_ms: kind === "image" ? 6000 : null, active_from: null, active_to: null, active_dows: "[0,1,2,3,4,5,6]", start_date: null, end_date: null, enabled: 1, show_on_customer: onCustomer }));
  });

  if (s.id === "st_demo_zs") sql.push(...demoHistory(s.id));
  sql.push(...demoUsage(s.id, { st_demo_zs: 1, st_demo_xy: 0.45, st_demo_xz: 0.7, st_demo_bq: 0.3, st_demo_ty: 0.25, st_smoke: 0.02 }[s.id] ?? 0));
  out.stores.push({
    id: s.id,
    code: s.code,
    name: s.name,
    adminEmail: `demo-${s.code.toLowerCase()}@example.com`,
    adminPassword: "demo-password",
    displayToken,
    staffDeviceToken,
    staff: staffNames.map(([name, pin], i) => ({ id: `${s.id}_staff${i + 1}`, name, pin })),
    urls: {
      display: `http://localhost:5174/?token=${displayToken}`,
      staff: `http://localhost:5173/?device=${staffDeviceToken}`,
    },
  });
}

/**
 * 總後台用量頁示範（M4）：過去 35 個 UTC 日的每小時用量（台北 11～21 點營業）。固定亂數種子。
 * 中山店前一晚台北 03:00 有 14 次夜間喚醒 → 「夜間 DO 未休眠」警示。日／月彙總由 API 查詢時補算。
 */
function demoUsage(storeId, scale) {
  if (!scale) return [];
  let x = storeId.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let d = 35; d >= 1; d--) {
    const day = today - d * 86400_000;
    const weekend = [0, 6].includes(new Date(day + 8 * 3600_000).getUTCDay());
    for (let h = 3; h <= 13; h++) {
      const peak = h === 4 || h === 10 || h === 11 ? 1.8 : 1;
      const tickets = Math.round((8 + rnd() * 10) * peak * (weekend ? 1.3 : 1) * scale);
      out.push(row("usage_hourly", {
        store_id: storeId, hour_start: day + h * 3600_000,
        api_requests: tickets * 7 + Math.round(rnd() * 20 * scale), api_errors: rnd() < 0.05 ? 1 : 0, api_wall_ms: tickets * 7 * 35,
        ws_connects: 2 + Math.round(tickets * 0.8), ws_messages: Math.round(tickets * 3.2), do_rpc: tickets * 3, do_alarms: h === 13 ? 1 : 0,
        do_wakes: 6 + Math.round(rnd() * 8), do_night_wakes: 0, do_events: tickets * 5, do_rows_written: tickets * 12,
        tickets, calls: Math.round(tickets * 1.1), push_sent: Math.round(tickets * 0.6), push_failed: rnd() < 0.2 ? 1 : 0,
      }));
    }
    if (storeId === "st_demo_zs" && d === 1) {
      out.push(row("usage_hourly", { store_id: storeId, hour_start: day + 19 * 3600_000, api_requests: 0, api_errors: 0, api_wall_ms: 0, ws_connects: 14, ws_messages: 0, do_rpc: 0, do_alarms: 0, do_wakes: 0, do_night_wakes: 14, do_events: 0, do_rows_written: 0, tickets: 0, calls: 0, push_sent: 0, push_failed: 0 }));
    }
  }
  return out;
}

/**
 * 示範報表用：前 7 個營業日的歷史（只有遮罩姓名、無手機原文與 HMAC，ADR-015）。固定亂數種子，重跑結果相同。
 */
function demoHistory(storeId) {
  let x = 20261027;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(ms);
  for (let d = 7; d >= 1; d--) {
    const bd = ymd(now - d * 86400_000);
    const base = Date.parse(`${bd}T11:00:00+08:00`);
    for (const [svc, prefix, count] of [["A", "A", 18 + Math.floor(rnd() * 14)], ["B", "B", 6 + Math.floor(rnd() * 8)]]) {
      for (let i = 1; i <= count; i++) {
        const created = base + Math.floor(rnd() * 9 * 3600_000) + (rnd() < 0.4 ? 1.2 * 3600_000 : 0);
        const r = rnd();
        const status = r < 0.82 ? "done" : r < 0.9 ? "skipped" : r < 0.95 ? "no_show" : "cancelled";
        const called = status === "cancelled" ? null : created + Math.floor((2 + rnd() * 18) * 60_000);
        const serving = status === "done" ? called + 30_000 : null;
        const ended = status === "done" ? serving + Math.floor((3 + rnd() * 6) * 60_000) : (called ?? created) + 5 * 60_000;
        out.push(row("tickets_history", {
          id: `${storeId}_h_${bd}_${svc}_${i}`, store_id: storeId, business_date: bd, service_id: `${storeId}_${svc}`,
          number: `${prefix}${String(i).padStart(3, "0")}`, final_status: status, name_masked: "王○明", phone_hmac: null, phone_masked: null,
          counter_id: `${storeId}_c1`, staff_id: null, recall_count: 0, transfer_count: 0,
          created_at: created, called_at: called, serving_at: serving, ended_at: ended, source: "qr",
        }));
      }
    }
  }
  return out;
}

// 平台本身（健康檢查、配對等不屬於門店的請求）與上個月的帳單（總後台分攤示範）
{
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let d = 35; d >= 1; d--) sql.push(row("usage_hourly", { store_id: "_platform", hour_start: today - d * 86400_000 + 2 * 3600_000, api_requests: 288 }));
  const last = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const bill = { workers_base: 5, workers_requests: 0, workers_cpu: 0, do_requests: 0, do_duration: 0, do_storage: 0, d1: 0, kv: 0, r2: 0, queues: 0, analytics_engine: 0, other: 0.37 };
  for (const [item, amt] of Object.entries(bill)) {
    if (amt) sql.push(row("billing_inputs", { month: last, line_item: item, amount_usd: amt, source: "invoice", entered_by: "dev@local", entered_at: now }));
  }
}

const sqlFile = join(apiDir, ".wrangler/seed.sql");
mkdirSync(dirname(sqlFile), { recursive: true });
writeFileSync(sqlFile, sql.join("\n") + "\n");

const wranglerBin = join(apiDir, "node_modules/.bin/wrangler");
const common = ["--local", "--env", "local", ...(persistTo ? ["--persist-to", resolve(persistTo)] : [])];
const run = (a) => execFileSync(wranglerBin, a, { cwd: apiDir, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CI: "1" } }).toString();
run(["d1", "migrations", "apply", "qcs-db-local", ...common]);
run(["d1", "execute", "qcs-db-local", ...common, "--file", sqlFile]);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log("✓ 本機 seed 完成\n");
for (const s of out.stores.filter((x) => x.id !== "st_smoke" && x.urls)) {
  console.log(`【${s.name}】門店碼 ${s.code}`);
  console.log(`  面板：${s.urls.display}`);
  console.log(`  人員：${s.urls.staff}`);
  console.log(`  人員 PIN：${s.staff.map((u) => `${u.name} ${u.pin}`).join("、")}`);
  console.log(`  門店後台：http://localhost:5172/  ${s.adminEmail} ／ ${s.adminPassword}\n`);
}
console.log("【總後台】http://localhost:5171/（本機以 DEV_BYPASS_ACCESS 免 Access，身分 dev@local）");
console.log(`（完整輸出：${outFile}）`);

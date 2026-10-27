#!/usr/bin/env node
/**
 * 本機 seed（11-local-testing §2）：套用 migration → 灌入 1 品牌、2 門店（＋smoke 門店）、各 2 服務、3 櫃台、
 * 店長＋3 位人員、已配對面板與人員手機、10 筆佔位廣告。只允許本機（--local），拒絕任何遠端環境。
 *
 * 用法：node scripts/seed-local.mjs [--persist-to <dir>] [--out <json>]
 * 冪等：INSERT OR REPLACE，重跑會覆蓋 demo 資料。
 */
import { execFileSync } from "node:child_process";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
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
  { id: "st_smoke", code: "SMOKE1", name: "smoke 測試門店", hours: [], voice: {} },
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
      status: "active",
      expires_at: null,
      max_devices: 2,
      max_staff: 10,
      ad_quota_bytes: 524288000,
      features: JSON.stringify({ push: true, ads: true, voice: true, showMaskedName: false, demo: true }),
      timezone: "Asia/Taipei",
      business_hours: JSON.stringify(s.hours),
      qr_key_version: 1,
      voice_settings: JSON.stringify(s.voice),
      logo_r2_key: null,
      created_at: now,
      updated_at: now,
    }),
  );
  sql.push(row("services", { id: `${s.id}_A`, store_id: s.id, name: "內用", prefix: "A", sort_order: 1, enabled: 1, daily_limit: null, created_at: now }));
  sql.push(row("services", { id: `${s.id}_B`, store_id: s.id, name: "外帶", prefix: "B", sort_order: 2, enabled: 1, daily_limit: null, created_at: now }));
  [
    [1, [`${s.id}_A`]],
    [2, [`${s.id}_A`]],
    [3, [`${s.id}_B`]],
  ].forEach(([n, svc]) =>
    sql.push(row("counters", { id: `${s.id}_c${n}`, store_id: s.id, name: `${n} 號櫃台`, number: n, service_ids: JSON.stringify(svc), enabled: 1, created_at: now })),
  );
  sql.push(
    row("users", {
      id: `${s.id}_admin`,
      role: "store_admin",
      store_id: s.id,
      display_name: "店長",
      email: `demo-${s.code.toLowerCase()}@example.com`,
      password_hash: hash("demo-password"),
      pin_hash: null,
      status: "active",
      failed_attempts: 0,
      locked_until: null,
      token_version: 1,
      created_at: now,
      updated_at: now,
    }),
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
    row("devices", { id, store_id: s.id, kind, name, pairing_code: null, pairing_expires_at: null, token_version: 1, counter_id: null, last_seen_at: null, client_kind: null, audio_status: null, audio_status_at: null, status: "active", created_at: now });
  sql.push(dev(`${s.id}_d1`, "display", "叫號面板 1"));
  sql.push(dev(`${s.id}_sd1`, "staff_device", "櫃台手機 1"));
  const exp = Math.floor(now / 1000) + YEAR;
  const displayToken = jwt({ sub: `${s.id}_d1`, role: "display", store_id: s.id, tv: 1, exp });
  const staffDeviceToken = jwt({ sub: `${s.id}_sd1`, role: "staff_device", store_id: s.id, tv: 1, exp });

  // 佔位廣告（apps/display/public/demo-ads；本機 MEDIA_BASE 指向 display 自己）
  const assets = [...Array.from({ length: 9 }, (_, i) => [`ad${i + 1}.svg`, "image", "image/svg+xml"]), ["ad-video.mp4", "video", "video/mp4"]];
  sql.push(row("ad_playlists", { id: `${s.id}_pl`, owner_type: "store", owner_id: s.id, version: 1, accept_brand: 1, updated_at: now }));
  assets.forEach(([file, kind, mime], i) => {
    const id = `${s.id}_ad${i + 1}`;
    sql.push(row("ad_assets", { id, owner_type: "store", owner_id: s.id, kind, r2_key: `demo-ads/${file}`, sha256: `demo-${file}`, mime, bytes: 1000, width: 1080, height: 720, duration_ms: kind === "video" ? 8000 : null, status: "ready", created_by: null, created_at: now }));
    sql.push(row("ad_playlist_items", { id: `${s.id}_it${i + 1}`, playlist_id: `${s.id}_pl`, asset_id: id, sort_order: i, duration_ms: kind === "image" ? 6000 : null, active_from: null, active_to: null, active_dows: "[0,1,2,3,4,5,6]", start_date: null, end_date: null, enabled: 1 }));
  });

  out.stores.push({
    id: s.id,
    code: s.code,
    name: s.name,
    displayToken,
    staffDeviceToken,
    staff: staffNames.map(([name, pin], i) => ({ id: `${s.id}_staff${i + 1}`, name, pin })),
    urls: {
      display: `http://localhost:5174/?token=${displayToken}`,
      staff: `http://localhost:5173/?device=${staffDeviceToken}`,
    },
  });
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
for (const s of out.stores.filter((x) => x.id !== "st_smoke")) {
  console.log(`【${s.name}】門店碼 ${s.code}`);
  console.log(`  面板：${s.urls.display}`);
  console.log(`  人員：${s.urls.staff}`);
  console.log(`  人員 PIN：${s.staff.map((u) => `${u.name} ${u.pin}`).join("、")}\n`);
}
console.log(`（完整輸出：${outFile}）`);

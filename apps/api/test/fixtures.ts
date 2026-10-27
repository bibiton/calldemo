import { env } from "./test-env";
import { hashSecret } from "../src/lib/password";
import { signJwt } from "../src/lib/jwt";
import { uniq } from "./helpers";

export interface Seeded {
  storeId: string;
  code: string;
  displayToken: string;
  staffDeviceToken: string;
  staffUserId: string;
  pin: string;
  adminId: string;
  adminEmail: string;
  adminPassword: string;
}

/** 種子 token 的到期：固定在遙遠未來，對真實時間與 2054 年的固定時鐘（見 fixture-dates.test.ts）都有效。 */
const TOKEN_EXP = Math.floor(Date.UTC(2100, 0, 1) / 1000);

export async function seedStore(over: { status?: string; expiresAt?: number | null; maxStaff?: number; maxDevices?: number; adQuota?: number } = {}): Promise<Seeded> {
  const storeId = uniq("st");
  const code = storeId.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const now = Date.now();
  const pinHash = await hashSecret("123456", 1000);
  const adminEmail = `${storeId}@example.com`;
  const pwHash = await hashSecret("correct-horse", 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO brands(id,name,created_at,updated_at) VALUES('brand_default','預設品牌',?,?)").bind(now, now),
    env.DB.prepare(
      "INSERT INTO stores(id,brand_id,code,name,status,expires_at,timezone,business_hours,max_staff,max_devices,ad_quota_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(storeId, "brand_default", code, "測試店", over.status ?? "active", over.expiresAt ?? null, "Asia/Taipei", "[]", over.maxStaff ?? 10, over.maxDevices ?? 2, over.adQuota ?? 524288000, now, now),
    env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(`${storeId}_admin`, "store_admin", storeId, "店長", adminEmail, pwHash, now, now),
    env.DB.prepare("INSERT INTO services(id,store_id,name,prefix,sort_order,created_at) VALUES(?,?,?,?,?,?)").bind(`${storeId}_A`, storeId, "內用", "A", 1, now),
    env.DB.prepare("INSERT INTO services(id,store_id,name,prefix,sort_order,created_at) VALUES(?,?,?,?,?,?)").bind(`${storeId}_B`, storeId, "外帶", "B", 2, now),
    env.DB.prepare("INSERT INTO counters(id,store_id,name,number,service_ids,created_at) VALUES(?,?,?,?,?,?)").bind(`${storeId}_c1`, storeId, "1 號櫃台", 1, "[]", now),
    env.DB.prepare("INSERT INTO users(id,role,store_id,display_name,pin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(`${storeId}_u1`, "staff", storeId, "王店員", pinHash, now, now),
    env.DB.prepare("INSERT INTO devices(id,store_id,kind,name,status,created_at) VALUES(?,?,?,?,?,?)").bind(`${storeId}_d1`, storeId, "display", "面板 1", "active", now),
    env.DB.prepare("INSERT INTO devices(id,store_id,kind,name,status,created_at) VALUES(?,?,?,?,?,?)").bind(`${storeId}_sd1`, storeId, "staff_device", "櫃台手機", "active", now),
  ]);
  const exp = TOKEN_EXP;
  const displayToken = await signJwt(env.JWT_SECRET, { sub: `${storeId}_d1`, role: "display", store_id: storeId, tv: 1, exp });
  const staffDeviceToken = await signJwt(env.JWT_SECRET, { sub: `${storeId}_sd1`, role: "staff_device", store_id: storeId, tv: 1, exp });
  return { storeId, code, displayToken, staffDeviceToken, staffUserId: `${storeId}_u1`, pin: "123456", adminId: `${storeId}_admin`, adminEmail, adminPassword: "correct-horse" };
}

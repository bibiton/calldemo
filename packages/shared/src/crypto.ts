const enc = new TextEncoder();

export function toBytes(s: string | Uint8Array): Uint8Array {
  return typeof s === "string" ? enc.encode(s) : s;
}

export async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", toBytes(key) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, toBytes(data) as BufferSource));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(b: Uint8Array): string {
  return b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(p + "=".repeat((4 - (p.length % 4)) % 4));
}

/** 常數時間比較（長度不同直接 false，長度本身不是秘密）。 */
export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

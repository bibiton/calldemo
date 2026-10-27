const M = "○";

/** 王明→王○、王小明→王○明、歐陽小明→歐○○明、Alice→A○○○e（03-data-model §4）。 */
export function maskName(name: string): string {
  const c = Array.from((name ?? "").trim());
  if (c.length <= 1) return c.join("");
  if (c.length === 2) return c[0] + M;
  return c[0] + M.repeat(c.length - 2) + c[c.length - 1];
}

/** 0912345678 → 0912***678 */
export function maskPhone(phone: string): string {
  if (!phone) return "";
  if (phone.length < 7) return "*".repeat(phone.length);
  return phone.slice(0, 4) + "***" + phone.slice(-3);
}

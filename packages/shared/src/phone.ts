/** 台灣手機正規化：接受 0912-345-678、+886912345678、886912345678；輸出 09xxxxxxxx，不合格回 null。 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.replace(/[\s\-()]/g, "");
  if (s.startsWith("+886")) s = s.slice(4);
  else if (s.startsWith("886") && s.length >= 12) s = s.slice(3);
  if (s.startsWith("9") && s.length === 9) s = "0" + s;
  return /^09\d{8}$/.test(s) ? s : null;
}

export const NAME_MAX = 20;

/** 姓名：去前後空白後 1～20 字（以 code point 計）。 */
export function validateName(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const len = Array.from(s).length;
  return len >= 1 && len <= NAME_MAX ? s : null;
}

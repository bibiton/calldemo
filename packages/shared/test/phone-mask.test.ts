import { describe, expect, it } from "vitest";
import { normalizePhone, validateName } from "../src/phone";
import { maskName, maskPhone } from "../src/mask";

describe("T10 手機格式", () => {
  it("0912-345-678 正規化通過", () => {
    expect(normalizePhone("0912-345-678")).toBe("0912345678");
  });
  it("+886912345678 正規化通過", () => {
    expect(normalizePhone("+886912345678")).toBe("0912345678");
  });
  it("0812345678 不是手機 → null", () => {
    expect(normalizePhone("0812345678")).toBeNull();
  });
  it("空白、空字串、過長、含字母 → null", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("09123456789")).toBeNull();
    expect(normalizePhone("0912abc678")).toBeNull();
  });
  it("容忍空白與 886 不帶 +", () => {
    expect(normalizePhone(" 0912 345 678 ")).toBe("0912345678");
    expect(normalizePhone("886912345678")).toBe("0912345678");
    expect(normalizePhone("+886 0912345678")).toBe("0912345678");
  });
});

describe("姓名驗證", () => {
  it("去除前後空白，1～20 字", () => {
    expect(validateName("  王小明 ")).toBe("王小明");
    expect(validateName("")).toBeNull();
    expect(validateName("   ")).toBeNull();
    expect(validateName("一".repeat(20))).toBe("一".repeat(20));
    expect(validateName("一".repeat(21))).toBeNull();
  });
  it("以字元（code point）計，不以 UTF-16 單位計", () => {
    expect(validateName("𠮷".repeat(20))).toBe("𠮷".repeat(20));
  });
});

describe("遮罩規則（03-data-model §4）", () => {
  it.each([
    ["王明", "王○"],
    ["王小明", "王○明"],
    ["歐陽小明", "歐○○明"],
    ["Alice", "A○○○e"],
    ["王", "王"],
  ])("%s → %s", (input, out) => {
    expect(maskName(input)).toBe(out);
  });
  it("手機保留前 4 後 3", () => {
    expect(maskPhone("0912345678")).toBe("0912***678");
  });
  it("空值回空字串", () => {
    expect(maskName("")).toBe("");
    expect(maskPhone("")).toBe("");
  });
});

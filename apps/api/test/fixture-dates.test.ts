import { describe, expect, it } from "vitest";

/**
 * 固定時刻的 fixture 一律放在遙遠的未來（2054／2055，與 2026／2027 同一套曆法：28 年週期，星期幾與閏年都相同）。
 * 原因：DO 依假時鐘排的 storage alarm 是真的 alarm；假時刻一旦落在真實的過去，miniflare 會在測試中途自己觸發它
 * （關店把號碼轉 no_show、模擬叫號），測試就會隨真實日期壞掉。新增 fixture 請沿用 2054 年，別用「今天附近」的日期。
 */
const MIN_YEAR = 2030;
// @ts-expect-error import.meta.glob 由 Vite 在 vitest 執行時提供；api 套件沒有 vite/client 型別（Vite 需要字面呼叫，不能先取出函式）
const sources = import.meta.glob("./*.test.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("fixture 日期不依賴真實時間", () => {
  it("沒有任何測試用 Date.UTC 建出 2030 年以前的固定時刻", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/Date\.UTC\(\s*(\d{4})\s*,/g)) if (Number(m[1]) < MIN_YEAR) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});

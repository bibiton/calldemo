import { describe, expect, it } from "vitest";
import { businessDate, zonedTimeToUtc, closeAlarmAt } from "../src/business-date";

describe("營業日（門店時區）", () => {
  it("台灣 00:30 屬於當天，UTC 仍是前一天", () => {
    // 2026-10-27 00:30 台北 = 2026-10-26 16:30 UTC
    const t = Date.UTC(2026, 9, 26, 16, 30);
    expect(businessDate(t, "Asia/Taipei")).toBe("2026-10-27");
  });
  it("跨 UTC 午夜但未跨台灣午夜 → 同一營業日", () => {
    const before = Date.UTC(2026, 9, 26, 23, 50); // 台北 10/27 07:50
    const after = Date.UTC(2026, 9, 27, 0, 10); // 台北 10/27 08:10
    expect(businessDate(before, "Asia/Taipei")).toBe(businessDate(after, "Asia/Taipei"));
  });
  it("zonedTimeToUtc 換算台北時間", () => {
    expect(zonedTimeToUtc("2026-10-27", "21:00", "Asia/Taipei")).toBe(Date.UTC(2026, 9, 27, 13, 0));
  });
  it("zonedTimeToUtc 處理有夏令時間的時區", () => {
    // 2026-07-01 09:00 紐約 (EDT, UTC-4) = 13:00 UTC
    expect(zonedTimeToUtc("2026-07-01", "09:00", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 13, 0));
  });
  it("關店 alarm = 當日關店時間 + 30 分鐘", () => {
    const hours = [{ dow: 2, open: "09:00", close: "21:00" }]; // 2026-10-27 是週二
    expect(closeAlarmAt("2026-10-27", hours, "Asia/Taipei")).toBe(Date.UTC(2026, 9, 27, 13, 30));
  });
  it("當日無營業時段設定 → 預設 23:59 + 30 分（隔日 00:29）", () => {
    expect(closeAlarmAt("2026-10-27", [], "Asia/Taipei")).toBe(Date.UTC(2026, 9, 27, 16, 29));
  });
  it("跨午夜營業（close < open）→ 關店在隔日", () => {
    const hours = [{ dow: 2, open: "18:00", close: "02:00" }];
    expect(closeAlarmAt("2026-10-27", hours, "Asia/Taipei")).toBe(Date.UTC(2026, 9, 27, 18, 30));
  });
});

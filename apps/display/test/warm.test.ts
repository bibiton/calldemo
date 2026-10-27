import { describe, expect, it } from "vitest";
import { AudioWarmer, warmUrls } from "../src/audio/warm";
import { normalizeVoiceSettings } from "../src/audio/settings";
import { manifest } from "./fixtures";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("語音包漸進快取（07 §7）", () => {
  it("順序：叮咚／句型／來賓 → 已啟用前綴 → 櫃台 → 1～200 號 → 其餘號碼；不含未啟用主題包與 manualOnly", () => {
    const s = normalizeVoiceSettings({ mode: "fun", enabledPacks: ["waited"] });
    const urls = warmUrls(manifest, s, [{ prefix: "A" }, { prefix: "G" }]);
    const idx = (u: string) => urls.indexOf("/audio/" + u);
    expect(idx("prefix/std.mp3")).toBeGreaterThanOrEqual(0);
    expect(urls.some((u) => u.includes("chime/"))).toBe(true);
    expect(idx("prefix/wait01.mp3")).toBeGreaterThan(idx("prefix/std.mp3"));
    expect(urls.some((u) => u.includes("hungry"))).toBe(false);
    expect(urls.some((u) => u.includes("bday"))).toBe(false);
    expect(idx("number/A/001.mp3")).toBeGreaterThan(idx("prefix/wait01.mp3"));
    expect(idx("number/A/200.mp3")).toBeLessThan(idx("number/A/201.mp3"));
    expect(urls.some((u) => /letter\/G/.test(u))).toBe(true); // 非 A～F 字首用逐字母
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("標準版只預載「來賓」，不抓俏皮前綴", () => {
    const urls = warmUrls(manifest, normalizeVoiceSettings({ mode: "standard" }), [{ prefix: "A" }]);
    expect(urls.filter((u) => u.includes("/prefix/"))).toEqual(["/audio/prefix/std.mp3"]);
  });

  it("同時最多 4 個請求；暫停時不再發新請求，恢復後繼續；同網址只抓一次", async () => {
    let inflight = 0;
    let peak = 0;
    const done: string[] = [];
    const resolvers: (() => void)[] = [];
    const w = new AudioWarmer((u) => {
      inflight++;
      peak = Math.max(peak, inflight);
      return new Promise<void>((r) =>
        resolvers.push(() => {
          inflight--;
          done.push(u);
          r();
        }),
      );
    });
    w.enqueue(Array.from({ length: 10 }, (_, i) => `u${i}`));
    w.enqueue(["u0", "u1"]);
    expect(inflight).toBe(4);
    w.pause();
    resolvers.splice(0).forEach((r) => r());
    await tick();
    expect(inflight).toBe(0); // 暫停中：完成的不補新的
    w.resume();
    expect(inflight).toBe(4);
    while (resolvers.length) {
      resolvers.splice(0).forEach((r) => r());
      await tick();
    }
    expect(peak).toBe(4);
    expect(done.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `u${i}`).sort());
    expect(w.pending).toBe(0);
  });
});

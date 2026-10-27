import { describe, expect, it } from "vitest";
import { createPlanner, parseNumber } from "../src/audio/plan";
import { normalizeVoiceSettings } from "../src/audio/settings";
import { manifest, manifestWithInterjections, seq } from "./fixtures";

const call = (number: string, counterNo: number | null = 2, kind: "call" | "recall" | "skipped" = "call") => ({
  ticketId: "t_" + number,
  number,
  counterNo,
  kind,
});

describe("號碼解析", () => {
  it("A023 → A／23；AB005 → AB／5", () => {
    expect(parseNumber("A023")).toEqual({ letters: "A", n: 23 });
    expect(parseNumber("AB005")).toEqual({ letters: "AB", n: 5 });
    expect(parseNumber("??")).toBeNull();
  });
});

describe("叫號句型（依 assets/audio/manifest.json）", () => {
  it("標準版：叮咚 → 來賓 → A二十三號 → 請到二號櫃台，×2，停頓依 gapsMs", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "standard" }), seq(0.5));
    const plan = p.plan(call("A023"));
    expect(plan.segments.map((s) => s.key)).toEqual([
      "chime.dingdong",
      "prefix.std",
      "number.A.23",
      "counter.2",
      "prefix.std",
      "number.A.23",
      "counter.2",
    ]);
    expect(plan.segments.map((s) => s.gapBeforeMs)).toEqual([0, 250, 60, 220, 900, 60, 220]);
    expect(plan.segments[2].url).toBe("/audio/number/A/023.mp3");
    expect(plan.text).toBe("來賓，A23號，請到2號櫃台");
  });

  it("repeat=1、chime 款式依設定", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "standard", repeat: 1, chime: "chime.bell" }), seq(0.5));
    expect(p.plan(call("B008", 3)).segments.map((s) => s.key)).toEqual(["chime.bell", "prefix.std", "number.B.8", "counter.3"]);
  });

  it("俏皮版：命中機率時用趣味前綴，同一號碼重複唸沿用同一前綴", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "fun", funPrefixProb: 1 }), seq(0.1, 0.0));
    const keys = p.plan(call("A001")).segments.map((s) => s.key);
    expect(keys[1]).not.toBe("prefix.std");
    expect(keys[1]).toBe(keys[4]);
  });

  it("俏皮機率 0 → 一律來賓", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "fun", funPrefixProb: 0 }), seq(0.99));
    for (let i = 0; i < 5; i++) expect(p.plan(call(`A00${i + 1}`)).segments[1].key).toBe("prefix.std");
  });

  it("前綴池：venue=any 排除餐飲句；排除 manualOnly 與預設關閉；disabledLines 排除", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "fun", funPrefixProb: 1, disabledLines: ["prefix.wait01"] }), Math.random);
    const pool = p.prefixPool();
    expect(pool).not.toContain("prefix.std");
    expect(pool).not.toContain("prefix.hungry01");
    expect(pool).not.toContain("prefix.bday01");
    expect(pool).not.toContain("prefix.weather01");
    expect(pool).not.toContain("prefix.wait01");
    expect(pool).toContain("prefix.wait02");
  });

  it("venue=food 才含餓了系；指定 enabledPacks 時只用該包（含預設關閉的節慶包），manualOnly 仍排除", () => {
    const food = createPlanner(manifest, normalizeVoiceSettings({ venue: "food" }), Math.random).prefixPool();
    expect(food).toContain("prefix.hungry01");
    const fest = createPlanner(manifest, normalizeVoiceSettings({ venue: "food", enabledPacks: ["festival", "warm"] }), Math.random).prefixPool();
    expect(fest).toContain("prefix.fest01");
    expect(fest).toContain("prefix.warm01");
    expect(fest).not.toContain("prefix.hungry01");
    expect(fest).not.toContain("prefix.bday01");
  });

  it("連續兩次叫號不重複同一前綴", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ funPrefixProb: 1 }), seq(0, 0, 0, 0));
    const a = p.plan(call("A001")).prefixKey;
    const b = p.plan(call("A002")).prefixKey;
    expect(a).not.toBe(b);
  });

  it("重叫：叮咚 → 再叫一次 → 前綴 → 號碼 → 櫃台", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "standard", repeat: 1 }), seq(0.1));
    const keys = p.plan(call("A023", 2, "recall")).segments.map((s) => s.key);
    expect(keys[0]).toBe("chime.dingdong");
    expect(["phrase.recall1", "phrase.recall2"]).toContain(keys[1]);
    expect(keys.slice(2)).toEqual(["prefix.std", "number.A.23", "counter.2"]);
    expect(p.plan(call("A023", 2, "recall")).segments[2].gapBeforeMs).toBe(160);
  });

  it("過號提醒：叮咚 → 來賓 → 號碼 → 已經過號囉…（只唸一次）", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({}), seq(0.1));
    expect(p.plan(call("A023", 2, "skipped")).segments.map((s) => s.key)).toEqual(["chime.dingdong", "prefix.std", "number.A.23", "phrase.skipped"]);
  });

  it("字首不在 A～F 或兩字元：逐字母＋純號碼，字母間隔 30ms", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "standard", repeat: 1 }), seq(0.1));
    const g = p.plan(call("G012")).segments;
    expect(g.map((s) => s.key)).toEqual(["chime.dingdong", "prefix.std", "letter.G", "number._.12", "counter.2"]);
    expect(g[3].gapBeforeMs).toBe(30);
    const ab = p.plan(call("AB005")).segments.map((s) => s.key);
    expect(ab.slice(2, 5)).toEqual(["letter.A", "letter.B", "number._.5"]);
  });

  it("號碼超出 1～999 → 無法拼接（交給 speechSynthesis 備援）", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({}), seq(0.1));
    const plan = p.plan(call("A1000"));
    expect(plan.speechOnly).toBe(true);
    expect(plan.text).toContain("A1000號");
  });

  it("櫃台號超出 1～30 或沒有櫃台 → 請到櫃台辦理", () => {
    const p = createPlanner(manifest, normalizeVoiceSettings({ mode: "standard", repeat: 1 }), seq(0.1));
    expect(p.plan(call("A001", 31)).segments.at(-1)!.key).toBe("phrase.desk");
    expect(p.plan(call("A001", null)).segments.at(-1)!.key).toBe("phrase.desk");
  });
});

describe("T17 趣味語音頻率", () => {
  it("every=5 叫 10 次 → 插入 2 次；重叫不插、不計次", () => {
    const p = createPlanner(
      manifestWithInterjections,
      normalizeVoiceSettings({ mode: "fun", funPrefixProb: 0, interjection: { enabled: true, every: 5 } }),
      seq(0.1),
    );
    let inserted = 0;
    for (let i = 1; i <= 10; i++) {
      if (p.plan(call(`A${String(i).padStart(3, "0")}`)).interjected) inserted++;
      expect(p.plan(call("A001", 2, "recall")).interjected).toBe(false);
    }
    expect(inserted).toBe(2);
  });
  it("穿插句接在叫號句之後（最後一段）", () => {
    const p = createPlanner(manifestWithInterjections, normalizeVoiceSettings({ interjection: { enabled: true, every: 1 } }), seq(0.1));
    const plan = p.plan(call("A001"));
    expect(plan.segments.at(-1)!.key.startsWith("interj.")).toBe(true);
  });
  it("關閉時不插；語音包沒有穿插句時也不插", () => {
    const off = createPlanner(manifestWithInterjections, normalizeVoiceSettings({ interjection: { enabled: false, every: 1 } }), seq(0.1));
    expect(off.plan(call("A001")).interjected).toBe(false);
    const none = createPlanner(manifest, normalizeVoiceSettings({ interjection: { enabled: true, every: 1 } }), seq(0.1));
    expect(none.plan(call("A001")).interjected).toBe(false);
  });
  it("標準版＝完全關閉趣味語音：即使穿插開著也不插（ADR-025）", () => {
    const std = createPlanner(manifestWithInterjections, normalizeVoiceSettings({ mode: "standard", interjection: { enabled: true, every: 1 } }), seq(0.1));
    expect(std.plan(call("A001")).interjected).toBe(false);
  });
});

describe("語音設定預設值（03 §門店語音設定、ADR-025）", () => {
  it("缺欄位採預設；越界值夾回範圍", () => {
    expect(normalizeVoiceSettings({})).toMatchObject({ volume: 0.8, repeat: 2, mode: "fun", funPrefixProb: 0.3, chime: "chime.dingdong", interjection: { enabled: false, every: 5 } });
    expect(normalizeVoiceSettings({ repeat: 9, volume: 3, funPrefixProb: -1 })).toMatchObject({ repeat: 3, volume: 1, funPrefixProb: 0 });
  });
});

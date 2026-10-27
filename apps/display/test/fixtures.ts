import real from "../../../assets/audio/manifest.json";
import type { Manifest } from "../src/audio/types";

export const manifest = real as unknown as Manifest;

/** 現行語音包沒有趣味穿插句（category=interjection）；T17 用測試夾具補兩句。 */
export const manifestWithInterjections: Manifest = {
  ...manifest,
  files: [
    ...manifest.files,
    { key: "interj.t1", text: "測試穿插一", file: "interj/t1.mp3", category: "interjection" },
    { key: "interj.t2", text: "測試穿插二", file: "interj/t2.mp3", category: "interjection" },
  ],
};

/** 依序回傳給定值的亂數產生器（用完重複最後一個）。 */
export function seq(...xs: number[]): () => number {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
}

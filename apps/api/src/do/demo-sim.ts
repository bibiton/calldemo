/**
 * DEMO 門店模擬叫號（13-demo-seed §5）的純函式部分：開關判斷、間隔、動作抽籤、虛構姓名。
 * 實際執行在 StoreQueueDO 的 alarm（與關店 alarm 共用同一個 storage alarm，取最早者）。
 */

export const SIM_DEFAULT_SEC = 20;
export const SIM_MIN_SEC = 10;
export const SIM_MAX_SEC = 600;
/** 等候中少於此數才補一張號碼，隊伍不會無限變長 */
export const SIM_MAX_WAITING = 4;

/** 只有 DEMO 門店且開了模擬叫號才生效；一般門店永遠 false。 */
export function simEnabled(features: Record<string, boolean> | undefined | null): boolean {
  return features?.demo === true && features?.demoSimulate === true;
}

/** env DEMO_SIM_EVERY_SEC → 毫秒；未設定或不是數字用預設 20 秒，限制 10～600 秒。 */
export function simIntervalMs(raw: string | undefined | null): number {
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  const sec = Number.isFinite(n) ? Math.round(n) : SIM_DEFAULT_SEC;
  return Math.min(SIM_MAX_SEC, Math.max(SIM_MIN_SEC, sec)) * 1000;
}

export type SimAction = "callNext" | "recall" | "skip";

/** 約 85% 叫下一號、10% 重叫、5% 過號。 */
export function pickAction(r: number): SimAction {
  if (r < 0.85) return "callNext";
  if (r < 0.95) return "recall";
  return "skip";
}

/** 虛構姓名（不對應真實人物；DEMO 門店的面板若開遮罩姓名只會顯示「林○美」這類）。 */
export const DEMO_NAMES = [
  "林小美", "陳大文", "王雅婷", "張志明", "李佳穎", "黃建宏", "吳淑芬", "劉冠宇",
  "蔡依庭", "楊承恩", "許雅雯", "鄭家豪", "謝欣怡", "郭俊傑", "洪詩涵", "曾柏翰",
];

export function pick<T>(xs: readonly T[], r: number): T {
  return xs[Math.min(xs.length - 1, Math.floor(r * xs.length))];
}

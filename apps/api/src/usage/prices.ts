/**
 * 「依單價估算成本」用的公告單價（02-cost-model §1，查證日期 2026-10-27）與每請求假設（02 §2）。
 * 估算＝用量 × 單價，**不扣內含額度**（代表邊際成本上限，12 §5）。單價變動時只改這裡。
 */
export const PRICE_DATE = "2026-10-27";

export const UNIT = {
  workersRequest: 0.3 / 1e6,
  workersCpuMs: 0.02 / 1e6,
  kvRead: 0.5 / 1e6,
  aeDataPoint: 0.25 / 1e6, // 官方註明尚未開始計費；保守計入
  doRequest: 0.15 / 1e6,
  doGbSecond: 12.5 / 1e6,
  doRowWritten: 1 / 1e6,
  d1RowWritten: 1 / 1e6,
  r2GbMonth: 0.015,
  queueOp: 0.4 / 1e6,
} as const;

export const ASSUME = {
  cpuMsPerRequest: 3,
  kvReadsPerRequest: 0.5,
  doMemoryGb: 0.125, // DO duration 一律以 128 MB 計
  d1RowsPerTicket: 8,
  queueOpsPerMessage: 3, // 寫＋讀＋刪
  historyBatch: 25,
  /** do_active_seconds_est＝events × 0.05 ＋ wakes × 0.01（12 §2，係數待正式環境校正） */
  activeSecPerEvent: 0.05,
  activeSecPerWake: 0.01,
  /** DO 收到的 WS 訊息以 20:1 折算 request */
  wsMessagesPerRequest: 20,
} as const;

export interface DayUsage {
  api_requests: number;
  do_requests_est: number;
  do_active_seconds_est: number;
  do_rows_written_est: number;
  tickets: number;
  push_sent: number;
  r2_bytes: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** 單日估算成本（USD），分項回傳，總後台可顯示組成。 */
export function estDayCost(d: DayUsage, daysInMonth = 30) {
  const parts = {
    workers: d.api_requests * (UNIT.workersRequest + ASSUME.cpuMsPerRequest * UNIT.workersCpuMs),
    kv: d.api_requests * ASSUME.kvReadsPerRequest * UNIT.kvRead,
    analytics: d.api_requests * UNIT.aeDataPoint,
    doRequests: d.do_requests_est * UNIT.doRequest,
    doDuration: d.do_active_seconds_est * ASSUME.doMemoryGb * UNIT.doGbSecond,
    doStorage: d.do_rows_written_est * UNIT.doRowWritten,
    d1: d.tickets * ASSUME.d1RowsPerTicket * UNIT.d1RowWritten,
    r2: (d.r2_bytes / 1e9) * (UNIT.r2GbMonth / daysInMonth),
    queues: (d.push_sent + d.tickets / ASSUME.historyBatch) * ASSUME.queueOpsPerMessage * UNIT.queueOp,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: round6(total), parts };
}

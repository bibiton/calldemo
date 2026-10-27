import { describe, expect, it } from "vitest";
import { queueOrder } from "../src/protocol";

describe("queueOrder（ADR-042，與 DO 的 ORDER BY sort_key, ord 一致）", () => {
  it("先比 sortKey，再比 ord；不看 createdAt 或號碼", () => {
    const t = (n: string, sortKey: number, ord: number, createdAt = 0) => ({ n, sortKey, ord, createdAt });
    const list = [t("A001(隊尾重排)", 1000, 9, 1), t("A003", 1000, 3, 1000), t("A002", 1000, 2, 1000), t("B001", 999, 5, 999)];
    expect([...list].sort(queueOrder).map((x) => x.n)).toEqual(["B001", "A002", "A003", "A001(隊尾重排)"]);
  });
});

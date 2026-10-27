import { useState } from "react";
import { api, ApiError } from "./lib/api";
import { Shell } from "./Shell";
import type { Saved, StoreLite, Ticket } from "./saved";

/** 主畫面 app（iOS）開啟時沒有號碼：輸入 Safari 號碼頁上的轉交碼取回（07 §3）。 */
export function Resume({ onDone }: { onDone: (s: Saved, t: Ticket) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^\d{6}$/.test(code);

  async function submit() {
    if (!valid) {
      setErr("請輸入 6 位數字的轉交碼");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ticketToken: string; ticket: Ticket; store: StoreLite; push: { publicKey: string } | null }>("/api/transfer/redeem", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      onDone({ token: r.ticketToken, ticketId: r.ticket.id, store: r.store, push: r.push }, r.ticket);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "";
      setErr(c === "CODE_NOT_FOUND" ? "轉交碼錯誤或已過期，請回 Safari 號碼頁重新產生。" : c === "TICKET_ENDED" ? "這個號碼已結束。" : "網路連線不穩，請稍後再試。");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h2 className="text-xl font-bold">取回您的號碼</h2>
      <p className="mt-2 text-base leading-relaxed text-slate-600">請輸入 Safari 號碼頁上顯示的 6 位數轉交碼。</p>
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <label className="flex flex-col gap-2">
          <span className="text-base font-bold">轉交碼</span>
          <input
            className="min-h-14 rounded-xl border border-slate-300 bg-white px-4 text-center text-3xl font-bold tracking-[0.3em] tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            aria-invalid={!!err}
            data-testid="xfer-input"
          />
        </label>
        {err && (
          <p className="rounded-xl bg-red-50 p-3 text-base text-red-700" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="min-h-14 rounded-2xl bg-brand text-lg font-bold text-white disabled:bg-slate-400" disabled={busy} data-testid="xfer-submit">
          {busy ? "取回中…" : "取回號碼"}
        </button>
      </form>
      <p className="mt-6 text-center text-base text-slate-500">還沒取號？請掃描店內叫號面板上的 QR Code。</p>
    </Shell>
  );
}

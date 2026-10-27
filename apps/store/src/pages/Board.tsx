/** 即時隊列（05-apps §4）：各類別等候數、各櫃台目前號碼、可代操作（同人員端指令，走既有 WS、cmdId 冪等）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QcsSocket, ulid, type StaffTicket } from "@qcs/shared";
import { api, auth, freshToken } from "../lib/api";
import { wsUrl } from "../lib/env";
import { useMe } from "../lib/me";
import { Badge, Button, Card, Empty, ErrorBox, Loading, Page, toast } from "../ui";

const CMD_ERR: Record<string, string> = {
  QUEUE_EMPTY: "目前沒有人在等候",
  BAD_STATE: "號碼狀態已改變，請重新整理",
  COUNTER_INVALID: "櫃台不存在",
};

const STATUS: Record<string, { text: string; tone: "amber" | "green" | "slate" | "red" }> = {
  called: { text: "已叫號", tone: "amber" },
  serving: { text: "服務中", tone: "green" },
  skipped: { text: "過號", tone: "red" },
  waiting: { text: "等候中", tone: "slate" },
};

const mins = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 60_000));

export function Board() {
  const me = useMe();
  const [tickets, setTickets] = useState<Map<string, StaffTicket> | null>(null);
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [conn, setConn] = useState("connecting");
  const [devAudio, setDevAudio] = useState<Map<string, string | null>>(new Map());
  const [devNames, setDevNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const sock = useRef<QcsSocket | null>(null);
  const pending = useRef(new Map<string, { msg: unknown; resolve: (a: any) => void }>());
  const storeId = me.data?.store.id;

  useEffect(() => {
    if (!storeId) return;
    let alive = true;
    api<{ devices: { id: string; name: string }[] }>("/api/store/devices")
      .then((d) => alive && setDevNames(Object.fromEntries(d.devices.map((x) => [x.id, x.name]))))
      .catch(() => {});
    let s: QcsSocket | null = null;
    void freshToken().then(() => {
      if (!alive) return;
      s = new QcsSocket({
        url: (lastSeq) => wsUrl(`/ws/store/${storeId}?role=staff${lastSeq != null ? `&lastSeq=${lastSeq}` : ""}`),
        protocols: () => ["qcs.v1", `auth.${auth.token ?? ""}`],
        onStatus: (st) => {
          setConn(st);
          if (st === "open") for (const p of pending.current.values()) s?.send(p.msg);
          if (st === "closed") void freshToken(); // 重連前換好 token
        },
        onMessage: (m) => {
          if (m.t === "ack") {
            const p = pending.current.get(m.cmdId);
            if (p) {
              pending.current.delete(m.cmdId);
              p.resolve(m);
            }
            return;
          }
          if (m.t !== "evt") return;
          if (m.type === "snapshot") {
            const all = [...m.data.staff.waiting, ...m.data.staff.active, ...m.data.staff.skipped] as StaffTicket[];
            setTickets(new Map(all.map((t) => [t.id, t])));
            setWaiting(m.data.waiting ?? {});
            setDevAudio(new Map((m.data.devices ?? []).map((d: any) => [d.deviceId, d.audio])));
          } else if (m.type?.startsWith("ticket.") && m.data?.id) {
            setTickets((prev) => new Map(prev ?? []).set(m.data.id, m.data as StaffTicket));
            if (m.data.waiting) setWaiting(m.data.waiting);
          } else if (m.type === "device.status") {
            setDevAudio((prev) => new Map(prev).set(m.data.deviceId, m.data.audio));
          } else if (m.type === "store.closed" || m.type === "settings.changed") {
            s?.send({ t: "resync" });
            if (m.type === "settings.changed") me.reload();
          }
        },
      });
      sock.current = s;
      s.start();
    });
    return () => {
      alive = false;
      s?.stop();
    };
  }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (key: string, cmd: string, args: Record<string, unknown>) => {
    const cmdId = ulid();
    const msg = { t: "cmd", cmdId, cmd, args };
    setBusy(key);
    const ack = await new Promise<any>((resolve) => {
      pending.current.set(cmdId, { msg, resolve });
      sock.current?.send(msg);
    });
    setBusy(null);
    if (!ack.ok) toast(CMD_ERR[ack.error] ?? `操作失敗（${ack.error}）`, "err");
    return ack;
  }, []);

  const list = useMemo(() => [...(tickets?.values() ?? [])], [tickets]);
  if (me.error) return <Page title="即時隊列"><ErrorBox text={me.error} onRetry={me.reload} /></Page>;
  if (!me.data || !tickets) return <Page title="即時隊列"><Loading text="連線到隊列中…" /></Page>;

  const { services, counters } = me.data.store;
  const svc = (id: string) => services.find((s) => s.id === id);
  const queue = list.filter((t) => t.status === "waiting").sort((a, b) => a.createdAt - b.createdAt);
  const skipped = list.filter((t) => t.status === "skipped");
  const blocked = [...devAudio.entries()].filter(([, a]) => a === "blocked").map(([id]) => devNames[id] ?? "叫號面板");
  const offline = conn !== "open";

  return (
    <Page
      title="即時隊列"
      actions={
        <span className={`mr-2 rounded-full px-3 py-1 text-sm font-bold ${offline ? "bg-amber-400 text-black" : "bg-emerald-500/20 text-emerald-100"}`} data-testid="conn" role="status">
          {offline ? "連線中…" : "● 即時"}
        </span>
      }
      testId="board"
    >
      {blocked.length > 0 && (
        <div className="rounded-2xl bg-red-600 p-4 text-base text-white" role="alert" data-testid="audio-alert">
          <p className="font-bold">🔇 叫號機無法出聲：{blocked.join("、")}</p>
          <p className="mt-1 text-white/90">請到面板前按一下遙控器 OK 或點一下畫面。</p>
        </div>
      )}

      <section className="grid grid-cols-2 gap-3" aria-label="各類別等候數" data-testid="waiting-summary">
        {services.map((s) => (
          <Card key={s.id} className="!p-3">
            <p className="flex items-center gap-2 text-base font-bold text-slate-700">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm text-white">{s.prefix}</span>
              <span className="truncate">{s.name}</span>
            </p>
            <p className="mt-1 text-base text-slate-500">
              等候 <b className="text-3xl text-slate-900 tabular-nums">{waiting[s.id] ?? 0}</b> 位
            </p>
          </Card>
        ))}
      </section>

      <h2 className="mt-2 text-base font-bold text-slate-600">櫃台</h2>
      {counters.length === 0 && <Empty title="還沒有櫃台" text="請到「設定 → 櫃台」新增。" />}
      {counters.map((c) => {
        const cur = list
          .filter((t) => (t.status === "called" || t.status === "serving") && t.counterId === c.id)
          .sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0))[0];
        const st = cur ? STATUS[cur.status] : null;
        return (
          <Card key={c.id} testId={`counter-card-${c.number}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-bold">{c.name}</h3>
              {st && <Badge tone={st.tone}>{st.text}</Badge>}
            </div>
            {cur ? (
              <div className="mt-1 flex items-baseline gap-3">
                <span className="text-4xl font-black text-brand tabular-nums" data-testid={`counter-current-${c.number}`}>
                  {cur.number}
                </span>
                <span className="truncate text-base text-slate-700">{cur.name ?? "（未留姓名）"}</span>
              </div>
            ) : (
              <p className="mt-1 text-base text-slate-500">目前沒有號碼</p>
            )}
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button className="col-span-3" disabled={offline || !!busy} onClick={() => void send(`next-${c.id}`, "callNext", { counterId: c.id })} data-testid={`call-next-${c.number}`}>
                {busy === `next-${c.id}` ? "叫號中…" : "叫下一號"}
              </Button>
              <Button kind="secondary" disabled={offline || !!busy || cur?.status !== "called"} onClick={() => cur && void send(`recall-${c.id}`, "recall", { ticketId: cur.id })}>
                重叫
              </Button>
              <Button kind="secondary" disabled={offline || !!busy || cur?.status !== "called"} onClick={() => cur && void send(`skip-${c.id}`, "skip", { ticketId: cur.id })}>
                過號
              </Button>
              <Button kind="secondary" disabled={offline || !!busy || !cur} onClick={() => cur && void send(`finish-${c.id}`, "finish", { ticketId: cur.id })}>
                完成
              </Button>
            </div>
          </Card>
        );
      })}

      <h2 className="mt-2 text-base font-bold text-slate-600">
        等候中 <span className="tabular-nums">{queue.length}</span> 位
      </h2>
      {queue.length === 0 ? (
        <Empty title="目前沒有人等候" text="顧客掃面板上的 QR Code 取號後會出現在這裡。" />
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-slate-100" data-testid="queue-list">
            {queue.map((t) => (
              <li key={t.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <span className="w-16 shrink-0 text-xl font-black text-brand tabular-nums">{t.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-bold">{t.name ?? "（未留姓名）"}</span>
                  <span className="block text-sm text-slate-500">
                    {svc(t.serviceId)?.name ?? ""}
                    {t.counterId ? ` · 指定 ${counters.find((x) => x.id === t.counterId)?.number ?? ""} 號櫃台` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-slate-500 tabular-nums">{mins(t.createdAt)} 分</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {skipped.length > 0 && (
        <>
          <h2 className="mt-2 text-base font-bold text-slate-600">過號</h2>
          <Card className="!p-0">
            <ul className="divide-y divide-slate-100">
              {skipped.map((t) => (
                <li key={t.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                  <span className="w-16 shrink-0 text-xl font-black text-slate-500 tabular-nums">{t.number}</span>
                  <span className="min-w-0 flex-1 truncate text-base">{t.name ?? "（未留姓名）"}</span>
                  <Button kind="secondary" className="!min-h-11 shrink-0" disabled={offline || !!busy} onClick={() => void send(`rq-${t.id}`, "requeue", { ticketId: t.id, position: "tail" })}>
                    重新排入
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </Page>
  );
}

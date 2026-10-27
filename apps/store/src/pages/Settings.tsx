import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { invalidateMe, useMe } from "../lib/me";
import { Button, Card, Confirm, ErrorBox, Loading, Page, Toggle, errText, toast } from "../ui";

export function Settings() {
  const me = useMe();
  const [masked, setMasked] = useState(false);
  const [ahead, setAhead] = useState(3);
  const [busy, setBusy] = useState(false);
  const [rotate, setRotate] = useState(false);

  useEffect(() => {
    if (!me.data) return;
    setMasked(!!me.data.store.features.showMaskedName);
    setAhead(me.data.store.notifyAhead ?? 3);
  }, [me.data]);

  async function save() {
    setBusy(true);
    try {
      await api("/api/store/settings/general", { method: "PUT", json: { showMaskedName: masked, notifyAhead: ahead } });
      toast("設定已儲存");
      invalidateMe();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Page
      title="其他設定"
      back="/more"
      testId="settings"
      footer={
        <Button className="w-full" onClick={() => void save()} disabled={busy || !me.data} data-testid="save">
          {busy ? "儲存中…" : "儲存"}
        </Button>
      }
    >
      {me.error && <ErrorBox text={me.error} onRetry={me.reload} />}
      {!me.data && !me.error && <Loading />}
      {me.data && (
        <>
          <Card>
            <h2 className="text-lg font-bold">顧客提醒</h2>
            <p className="mt-1 text-base text-slate-600">已開啟背景提醒的顧客，在前面剩幾位時收到「快輪到您了」通知。</p>
            <div className="mt-3 grid grid-cols-5 gap-2" role="radiogroup" aria-label="前面剩幾位時提醒">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={ahead === n}
                  className={`min-h-12 rounded-xl text-lg font-bold tabular-nums ${ahead === n ? "bg-brand text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}
                  onClick={() => setAhead(n)}
                  data-testid={`ahead-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-2 text-sm text-slate-500">目前：前面剩 {ahead} 位時提醒</p>
          </Card>
          <Card>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold">面板顯示遮罩姓名</h2>
                <p className="text-sm text-slate-500">叫號時在號碼旁顯示「王○明」</p>
              </div>
              <Toggle checked={masked} onChange={setMasked} label="面板顯示遮罩姓名" testId="masked" />
            </div>
          </Card>
          <Card>
            <h2 className="text-lg font-bold">QR Code 金鑰</h2>
            <p className="mt-1 text-base text-slate-600">懷疑取號網址被外流、有人遠端灌號時使用。重設後，所有舊的取號網址立即失效，面板會自動換新 QR Code。</p>
            <Button kind="danger" className="mt-3 w-full" onClick={() => setRotate(true)} data-testid="rotate-qr">
              重設 QR 金鑰
            </Button>
          </Card>
        </>
      )}
      {rotate && (
        <Confirm
          title="重設 QR 金鑰？"
          text="已掃碼但還沒取號的顧客需要重新掃描。已取到的號碼不受影響。"
          ok="重設"
          danger
          busy={busy}
          onCancel={() => setRotate(false)}
          onOk={async () => {
            setBusy(true);
            try {
              await api("/api/store/qr/rotate", { method: "POST" });
              toast("QR 金鑰已重設");
              setRotate(false);
            } catch (e) {
              toast(errText(e), "err");
            }
            setBusy(false);
          }}
        />
      )}
    </Page>
  );
}

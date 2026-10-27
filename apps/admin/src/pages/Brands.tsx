import { useState } from "react";
import { api } from "../lib/api";
import { Button, Card, Confirm, ErrorBox, Field, inputCls, Loading, Page, Sheet, errText, toast, useLoad } from "../ui";

interface Brand {
  id: string;
  name: string;
  stores: number;
}

export function Brands() {
  const { data, error, reload } = useLoad(() => api<{ brands: Brand[] }>("/api/admin/brands"));
  const [edit, setEdit] = useState<Brand | "new" | null>(null);
  const [del, setDel] = useState<Brand | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await api(`/api/admin/brands/${del.id}`, { method: "DELETE" });
      toast("已刪除品牌");
      setDel(null);
      reload();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }

  return (
    <Page
      title="品牌"
      back="/more"
      testId="brands"
      footer={
        <Button className="w-full" onClick={() => setEdit("new")} data-testid="new-brand">
          ＋ 新增品牌
        </Button>
      }
    >
      <p className="text-base text-slate-600">品牌用來分組門店。目前只有門店歸屬，品牌層廣告下發屬後續功能。</p>
      {error && <ErrorBox text={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <Card className="!p-0">
          <ul className="flex flex-col divide-y divide-slate-100" data-testid="brand-list">
            {data.brands.map((b) => (
              <li key={b.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold">{b.name}</p>
                  <p className="text-sm text-slate-500">{b.stores} 家門店</p>
                </div>
                <Button kind="secondary" className="min-h-11 px-3" onClick={() => setEdit(b)}>
                  改名
                </Button>
                <Button kind="danger" className="min-h-11 px-3" onClick={() => setDel(b)} disabled={b.stores > 0} aria-label={b.stores > 0 ? `${b.name} 還有門店，不能刪除` : `刪除 ${b.name}`}>
                  刪除
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data?.brands.some((b) => b.stores > 0) && <p className="text-sm text-slate-500">有門店的品牌不能刪除。</p>}
      {edit && <BrandSheet brand={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), reload())} />}
      {del && <Confirm title="刪除品牌？" text={`確定刪除「${del.name}」？`} ok="刪除" danger busy={busy} onOk={remove} onCancel={() => setDel(null)} />}
    </Page>
  );
}

function BrandSheet({ brand, onClose, onDone }: { brand: Brand | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(brand?.name ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = !name.trim() ? "請輸入品牌名稱" : null;
  async function save() {
    setTouched(true);
    if (err) return;
    setBusy(true);
    try {
      if (brand) await api(`/api/admin/brands/${brand.id}`, { method: "PUT", json: { name: name.trim() } });
      else await api("/api/admin/brands", { method: "POST", json: { name: name.trim() } });
      toast("已儲存");
      onDone();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  }
  return (
    <Sheet
      title={brand ? "品牌改名" : "新增品牌"}
      onClose={onClose}
      testId="brand-sheet"
      footer={
        <Button className="w-full" onClick={save} disabled={busy} data-testid="brand-save">
          {busy ? "儲存中…" : "儲存"}
        </Button>
      }
    >
      <Field label="品牌名稱" error={touched ? err : null}>
        <input className={inputCls} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!err} data-testid="brand-name" />
      </Field>
    </Sheet>
  );
}

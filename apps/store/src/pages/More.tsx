import { logout } from "../lib/api";
import { useMe } from "../lib/me";
import { navigate } from "../lib/router";
import { Button, Card, Page } from "../ui";

const ITEMS = [
  { to: "/services", title: "服務類別", desc: "名稱、字首、排序、每日上限" },
  { to: "/counters", title: "櫃台", desc: "櫃台號碼與可服務類別" },
  { to: "/staff", title: "人員帳號", desc: "新增人員、發／重設 PIN、停用" },
  { to: "/devices", title: "裝置", desc: "叫號面板與人員手機配對、解除" },
  { to: "/hours", title: "營業時間", desc: "每週營業時段" },
  { to: "/voice", title: "叫號語音", desc: "風格、俏皮前綴、叮咚、試聽" },
  { to: "/settings", title: "其他設定", desc: "顧客提醒、面板顯示、QR 金鑰" },
];

export function More() {
  const me = useMe();
  return (
    <Page title="設定" testId="more">
      {me.data && (
        <Card>
          <p className="text-sm text-slate-500">目前門店</p>
          <p className="text-lg font-bold">{me.data.store.name}</p>
          <p className="text-base text-slate-600">店長：{me.data.user.displayName}</p>
          {me.data.store.expiresAt && (
            <p className="text-sm text-slate-500">服務到期：{new Date(me.data.store.expiresAt).toLocaleDateString("zh-TW")}</p>
          )}
        </Card>
      )}
      <Card className="!p-0">
        <ul className="divide-y divide-slate-100">
          {ITEMS.map((it) => (
            <li key={it.to}>
              <button className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50" onClick={() => navigate(it.to)} data-testid={`more-${it.to.slice(1)}`}>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-bold">{it.title}</span>
                  <span className="block text-sm text-slate-500">{it.desc}</span>
                </span>
                <span className="text-2xl text-slate-400" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Button kind="secondary" onClick={() => void logout()} data-testid="logout">
        登出
      </Button>
    </Page>
  );
}

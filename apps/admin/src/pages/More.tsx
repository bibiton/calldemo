import type { Me } from "../App";
import { navigate } from "../lib/router";
import { Card, Page } from "../ui";

export function More({ me }: { me: Me }) {
  const item = (to: string, label: string, hint: string) => (
    <li>
      <button className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50" onClick={() => navigate(to)}>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-bold">{label}</span>
          <span className="block text-sm text-slate-500">{hint}</span>
        </span>
        <span className="text-2xl text-slate-400" aria-hidden>
          ›
        </span>
      </button>
    </li>
  );
  return (
    <Page title="更多" testId="more">
      <Card className="!p-0">
        <ul className="flex flex-col divide-y divide-slate-100">
          {item("/billing", "輸入帳單", "每月 Cloudflare 帳單金額，用來分攤每店成本")}
          {item("/brands", "品牌", "新增、改名、刪除品牌")}
          {item("/audit", "稽核紀錄", "全平台操作紀錄")}
        </ul>
      </Card>
      <Card>
        <p className="text-sm text-slate-500">目前登入</p>
        <p className="break-all text-base font-bold" data-testid="me-email">
          {me.email}
        </p>
        <p className="mt-1 text-sm text-slate-500">{me.mode === "access" ? "以 Cloudflare Access 驗證（信箱驗證碼）" : "本機開發模式（未經 Access）"}</p>
        {me.mode === "access" && (
          <a className="mt-3 flex min-h-12 items-center justify-center rounded-xl bg-white px-4 text-base font-bold text-red-700 ring-1 ring-red-300" href="/cdn-cgi/access/logout">
            登出
          </a>
        )}
      </Card>
    </Page>
  );
}

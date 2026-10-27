import { useState } from "react";
import { Button } from "../ui";

/** 初始／重設密碼：只顯示一次（大字、可複製、黃底提醒）。 */
export function PasswordOnce({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`帳號：${email}\n密碼：${password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200" data-testid="password-once">
      <p className="text-base font-bold text-amber-900">⚠ 密碼只顯示這一次，離開後無法再查看</p>
      <dl className="flex flex-col gap-2">
        <div>
          <dt className="text-sm text-slate-600">帳號</dt>
          <dd className="break-all text-lg font-bold text-slate-900">{email}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-600">密碼</dt>
          <dd className="font-mono text-2xl font-bold tracking-wider text-slate-900 select-all" data-testid="password">
            {password}
          </dd>
        </div>
      </dl>
      <Button kind="secondary" onClick={copy}>
        {copied ? "✓ 已複製" : "複製帳號與密碼"}
      </Button>
    </div>
  );
}

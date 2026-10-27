import { useState } from "react";

export function Shell({ children, storeName, logoUrl, step, demo }: { children: React.ReactNode; storeName?: string; logoUrl?: string | null; step?: number; demo?: boolean }) {
  // Logo 讀不到就退回門店名稱（不出現破圖）
  const [logoOk, setLogoOk] = useState(true);
  const showLogo = !!logoUrl && logoOk;
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="flex min-h-14 items-center justify-between gap-3 bg-brand px-4 py-2 text-white">
        <span className="flex min-w-0 items-center gap-2 text-lg font-bold">
          {showLogo ? (
            <span className="flex h-10 max-w-[60vw] items-center rounded-lg bg-white px-2 py-1" data-testid="store-logo">
              <img src={logoUrl!} alt={storeName ?? "門店"} className="h-full w-auto max-w-full object-contain" decoding="async" onError={() => setLogoOk(false)} />
            </span>
          ) : (
            <>
              <span className="h-3 w-3 shrink-0 rounded-full bg-accent" aria-hidden />
              <span className="truncate" data-testid="store-name">
                {storeName ?? "線上取號"}
              </span>
            </>
          )}
        </span>
        {step && <span className="shrink-0 text-sm text-white/80">步驟 {step} / 3</span>}
      </header>
      {demo && (
        <p className="bg-amber-100 py-1 text-center text-xs font-bold tracking-wider text-amber-900" data-testid="demo-badge">
          DEMO・虛構品牌
        </p>
      )}
      <main className="flex flex-1 flex-col px-4 pt-5 pb-28">{children}</main>
    </div>
  );
}
export function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-10 rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200" role="status">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-3 text-base leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

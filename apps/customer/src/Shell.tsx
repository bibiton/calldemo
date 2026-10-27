export function Shell({ children, storeName, step }: { children: React.ReactNode; storeName?: string; step?: number }) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="flex items-center justify-between bg-brand px-4 py-3 text-white">
        <span className="flex min-w-0 items-center gap-2 text-lg font-bold">
          <span className="h-3 w-3 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="truncate">{storeName ?? "線上取號"}</span>
        </span>
        {step && <span className="shrink-0 text-sm text-white/80">步驟 {step} / 3</span>}
      </header>
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

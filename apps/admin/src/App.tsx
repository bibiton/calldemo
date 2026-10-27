import { useEffect, useState } from "react";
import { api, onUnauthorized } from "./lib/api";
import { useRoute } from "./lib/router";
import { Button, ToastHost } from "./ui";
import { Stores } from "./pages/Stores";
import { StoreNew } from "./pages/StoreNew";
import { StoreDetail } from "./pages/StoreDetail";
import { Usage } from "./pages/Usage";
import { StoreUsage } from "./pages/StoreUsage";
import { Billing } from "./pages/Billing";
import { Audit } from "./pages/Audit";
import { Brands } from "./pages/Brands";
import { More } from "./pages/More";

export interface Me {
  email: string;
  mode: "access" | "dev-bypass";
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [gate, setGate] = useState<"checking" | "in" | "denied" | "offline">("checking");
  const { path } = useRoute();

  useEffect(() => {
    const off = onUnauthorized(() => setGate("denied"));
    api<Me>("/api/admin/me")
      .then((m) => {
        setMe(m);
        setGate("in");
      })
      .catch((e) => setGate(e?.status === 401 ? "denied" : "offline"));
    return () => {
      off();
    };
  }, []);

  if (gate === "checking")
    return (
      <main className="flex h-full items-center justify-center text-base text-slate-500" data-testid="checking">
        載入中…
      </main>
    );
  if (gate !== "in") return <Gate offline={gate === "offline"} />;
  return (
    <>
      <Routes path={path} me={me!} />
      <ToastHost />
    </>
  );
}

function Routes({ path, me }: { path: string; me: Me }) {
  const m = /^\/stores\/([^/]+)$/.exec(path);
  const u = /^\/usage\/stores\/([^/]+)$/.exec(path);
  switch (true) {
    case path === "/stores/new":
      return <StoreNew />;
    case !!m:
      return <StoreDetail id={decodeURIComponent(m![1])} />;
    case !!u:
      return <StoreUsage id={decodeURIComponent(u![1])} />;
    case path.startsWith("/usage"):
      return <Usage />;
    case path.startsWith("/billing"):
      return <Billing />;
    case path.startsWith("/audit"):
      return <Audit />;
    case path.startsWith("/brands"):
      return <Brands />;
    case path.startsWith("/more"):
      return <More me={me} />;
    default:
      return <Stores />;
  }
}

/** Access 驗證失敗（JWT 過期、名單外）或 API 連不上。 */
function Gate({ offline }: { offline: boolean }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center" data-testid={offline ? "offline" : "access-required"}>
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-200 text-3xl text-slate-700" aria-hidden>
        {offline ? "!" : "🔒"}
      </span>
      <h1 className="text-2xl font-bold text-slate-900">{offline ? "連不上伺服器" : "需要重新登入"}</h1>
      <p className="text-base leading-relaxed text-slate-600">
        {offline ? "請確認網路連線後再試一次。" : "總後台只開放給授權的信箱。請重新整理頁面，用公司信箱收驗證碼登入。"}
      </p>
      <Button onClick={() => location.reload()}>重新整理</Button>
    </main>
  );
}

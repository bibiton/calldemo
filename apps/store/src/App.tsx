import { useEffect, useState } from "react";
import { auth, refresh } from "./lib/api";
import { useRoute } from "./lib/router";
import { ToastHost } from "./ui";
import { Login } from "./pages/Login";
import { Board } from "./pages/Board";
import { Reports } from "./pages/Reports";
import { Ads } from "./pages/Ads";
import { More } from "./pages/More";
import { Services } from "./pages/Services";
import { Counters } from "./pages/Counters";
import { Staff } from "./pages/Staff";
import { Devices } from "./pages/Devices";
import { Hours } from "./pages/Hours";
import { Voice } from "./pages/Voice";
import { Settings } from "./pages/Settings";

type Gate = "checking" | "in" | "out" | "suspended" | "expired";

export function App() {
  const [gate, setGate] = useState<Gate>("checking");
  const { path } = useRoute();

  useEffect(() => {
    const off = auth.on((s) => setGate(s));
    // 開頁時用 refresh cookie 換 access token：免重新登入（14 天）
    void refresh().then((s) => setGate((g) => (g === "suspended" || g === "expired" ? g : s ? "in" : "out")));
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
  if (gate === "suspended" || gate === "expired") return <Suspended expired={gate === "expired"} />;
  if (gate === "out") return <Login />;

  return (
    <>
      <Routes path={path} />
      <ToastHost />
    </>
  );
}

function Routes({ path }: { path: string }) {
  switch (true) {
    case path === "/" || path === "/login":
      return <Board />;
    case path.startsWith("/reports"):
      return <Reports />;
    case path.startsWith("/ads"):
      return <Ads />;
    case path.startsWith("/services"):
      return <Services />;
    case path.startsWith("/counters"):
      return <Counters />;
    case path.startsWith("/staff"):
      return <Staff />;
    case path.startsWith("/devices") || path.startsWith("/pair"):
      return <Devices />;
    case path.startsWith("/hours"):
      return <Hours />;
    case path.startsWith("/voice"):
      return <Voice />;
    case path.startsWith("/settings"):
      return <Settings />;
    default:
      return <More />;
  }
}

function Suspended({ expired }: { expired: boolean }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-3 p-6 text-center" data-testid="suspended">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-3xl text-red-700" aria-hidden>
        !
      </span>
      <h1 className="text-2xl font-bold text-slate-900">{expired ? "門店服務已到期" : "門店服務已暫停"}</h1>
      <p className="text-base leading-relaxed text-slate-600">叫號面板與取號已暫停。如需恢復，請聯絡平台管理員。</p>
    </main>
  );
}

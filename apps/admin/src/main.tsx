import { createRoot } from "react-dom/client";
import "./index.css";

// 骨架：完整功能在 roadmap M3（門店後台）／M4（總後台）
function App() {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 p-6 text-slate-800">
      <h1 className="text-2xl font-bold text-brand">總後台</h1>
      <p className="text-base text-slate-600">骨架頁面。功能排在後續里程碑實作。</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

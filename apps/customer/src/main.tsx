import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { registerSw } from "./lib/push";

registerSw();
createRoot(document.getElementById("root")!).render(<App />);

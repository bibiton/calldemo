import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devProxy } from "../../packages/shared/vite/preset";
import { audioDevServer } from "./vite-audio";

// 語音試聽：開發時本機 /audio；部署時 VITE_AUDIO_BASE 指向 https://call-display.jjoy.ai/audio/（scripts/deploy.sh 設定）（display 端 _headers 開 CORS）
export default defineConfig({
  plugins: [react(), tailwindcss(), audioDevServer()],
  server: { proxy: devProxy },
  preview: { proxy: devProxy },
});

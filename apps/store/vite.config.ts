import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devProxy } from "../../packages/shared/vite/preset";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: devProxy },
  preview: { proxy: devProxy },
});

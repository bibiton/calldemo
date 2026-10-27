import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { devProxy } from "../../packages/shared/vite/preset";

const AUDIO_SRC = resolve(__dirname, "../../assets/audio");
const SKIP = new Set(["demo", "README.md", ".gen-cache.json"]);

/** 語音包隨 display 部署（ADR-026）：開發時直接由 assets/audio 提供，建置時複製到 dist/audio（排除 demo、README）。 */
function audioPack(): Plugin {
  let outDir = "dist";
  return {
    name: "qcs-audio-pack",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/audio", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
        const file = join(AUDIO_SRC, rel);
        if (!file.startsWith(AUDIO_SRC) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "audio/mpeg");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(AUDIO_SRC, join(outDir, "audio"), { recursive: true, filter: (src) => !SKIP.has(src.split(/[/\\]/).pop()!) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), audioPack()],
  server: { proxy: devProxy },
  preview: { proxy: devProxy },
});

/** 開發時由 assets/audio 直接提供 /audio/*（部署時語音包隨 display 上 Pages，ADR-026）。 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Plugin } from "vite";

export const AUDIO_SRC = resolve(import.meta.dirname, "../../assets/audio");

export function audioDevServer(): Plugin {
  return {
    name: "qcs-audio-dev",
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
  };
}

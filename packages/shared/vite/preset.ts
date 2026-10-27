/** 各前端 Vite 共用：/api 與 /ws 轉到本機 Worker（11-local-testing §2）。 */
export const API_TARGET = process.env.QCS_API_TARGET ?? "http://127.0.0.1:8787";
export const devProxy = {
  "/api": { target: API_TARGET, changeOrigin: false },
  "/ws": { target: API_TARGET, ws: true, changeOrigin: false },
};

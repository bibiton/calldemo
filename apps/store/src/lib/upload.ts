/** 廣告上傳前的前端檢查（05-apps §4、ADR-016／028）：格式、大小、解析度、長度；比例不符只提示不擋。 */
import { API_BASE } from "./env";
import { ApiError, api, freshToken } from "./api";

export const LIMITS = { imageBytes: 5 * 1024 * 1024, videoBytes: 50 * 1024 * 1024, videoMs: 120_000 };
const IMAGE = ["image/jpeg", "image/png", "image/webp"];
const VIDEO = ["video/mp4"];

export interface Inspected {
  file: File;
  kind: "image" | "video" | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  errors: string[];
  warnings: string[];
  previewUrl: string;
}

export const mb = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

function meta(file: File, kind: "image" | "video", url: string): Promise<{ w: number; h: number; ms: number | null }> {
  return new Promise((resolve, reject) => {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, ms: null });
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, ms: Math.round(v.duration * 1000) });
      v.onerror = () => reject(new Error("decode"));
      v.src = url;
    }
  });
}

export async function inspect(file: File, free: number): Promise<Inspected> {
  const kind = IMAGE.includes(file.type) ? "image" : VIDEO.includes(file.type) ? "video" : null;
  const previewUrl = URL.createObjectURL(file);
  const out: Inspected = { file, kind, width: null, height: null, durationMs: null, errors: [], warnings: [], previewUrl };
  if (!kind) {
    out.errors.push("只支援 JPG、PNG、WebP 圖片或 MP4（H.264）影片。");
    return out;
  }
  const max = kind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes;
  if (file.size > max) out.errors.push(`檔案 ${mb(file.size)}，超過${kind === "image" ? "圖片" : "影片"}上限 ${mb(max)}。`);
  if (file.size > free) out.errors.push(`廣告容量剩 ${mb(Math.max(0, free))}，放不下這個檔案（${mb(file.size)}）。請先刪除不用的素材。`);
  try {
    const m = await meta(file, kind, previewUrl);
    out.width = m.w;
    out.height = m.h;
    out.durationMs = m.ms;
    if (kind === "video" && m.ms != null && m.ms > LIMITS.videoMs) out.errors.push(`影片長度 ${Math.round(m.ms / 1000)} 秒，超過上限 120 秒。`);
    if (m.w && m.h && Math.abs(m.w / m.h - 1.5) > 0.02)
      out.warnings.push(`比例 ${m.w}×${m.h} 不是 3:2。面板會完整顯示並在兩側補模糊底，不會裁切；建議 1080×720。`);
    if (m.w && m.h && (m.w < 1080 || m.h < 720)) out.warnings.push("解析度低於 1080×720，電視上可能較模糊。");
  } catch {
    out.errors.push(kind === "video" ? "無法讀取影片，請確認是 H.264 編碼的 MP4。" : "無法讀取圖片，檔案可能已損毀。");
  }
  return out;
}

async function sha256(file: File): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** 申請上傳（Worker 檢查容量）→ PUT 原始檔（XHR 才有上傳進度）。 */
export async function upload(it: Inspected, name: string, onProgress: (p: number) => void): Promise<void> {
  onProgress(0);
  const init = await api<{ uploadUrl: string }>("/api/store/ads/uploads", {
    method: "POST",
    json: { kind: it.kind, mime: it.file.type, bytes: it.file.size, sha256: await sha256(it.file), width: it.width, height: it.height, durationMs: it.durationMs, name },
  });
  const token = await freshToken();
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", API_BASE + init.uploadUrl);
    x.withCredentials = true;
    if (token) x.setRequestHeader("authorization", `Bearer ${token}`);
    x.setRequestHeader("content-type", it.file.type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let code = "ERROR";
      try {
        code = JSON.parse(x.responseText).code ?? code;
      } catch {
        /* ignore */
      }
      reject(new ApiError(x.status, code));
    };
    x.onerror = () => reject(new ApiError(0, "NETWORK"));
    x.send(it.file);
  });
  onProgress(1);
}

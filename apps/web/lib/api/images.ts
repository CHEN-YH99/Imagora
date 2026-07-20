import { apiFetch, apiBaseUrl } from "./client";

export function resolveImageSrc(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      if (normalized.startsWith("/api/files/")) {
        return `${apiBaseUrl}${normalized}`;
      }
      return normalized;
    }
  }
  return null;
}

export async function downloadGeneratedImage(imageId: string): Promise<string> {
  const result = await apiFetch<{ url: string; fileName: string }>(`/api/images/${imageId}/download-url`, {
    method: "POST",
    body: {}
  });
  const downloadSrc = resolveImageSrc(result.url);
  if (!downloadSrc) {
    throw new Error("下载链接无效，请稍后重试。");
  }
  const response = await fetch(downloadSrc);
  if (!response.ok) {
    throw new Error("下载失败，请稍后重试。");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = result.fileName;
    anchor.rel = "noreferrer";
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return result.fileName;
}

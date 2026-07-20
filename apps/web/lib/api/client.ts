import { ApiRequestError } from "./errors";

const defaultApiBaseUrl = "http://127.0.0.1:4100";
const defaultRequestTimeoutMs = 15_000;

export const apiBaseUrl = resolveApiBaseUrl();
export const SESSION_EXPIRED_EVENT = "imagora:session-expired";

export async function apiFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultRequestTimeoutMs);

  try {
    const response = await fetch(`${resolveApiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await readApiPayload<T>(response);
    if (!response.ok || !payload.data) {
      if (response.status === 401 && payload.error?.code === "UNAUTHORIZED" && !isAuthEndpoint(path)) {
        notifySessionExpired();
      }
      throw new ApiRequestError(payload.error?.code, payload.error?.message, response.status);
    }
    return payload.data;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("请求超时，请检查网络后重试。");
    }
    if (error instanceof TypeError) {
      throw new Error("网络连接失败，请检查网络后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function resolveApiBaseUrl(): string {
  const configured = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);
  if (typeof window === "undefined") {
    return configured ?? defaultApiBaseUrl;
  }
  if (!isLocalHostname(window.location.hostname)) {
    return configured ?? defaultApiBaseUrl;
  }
  if (!configured) {
    return `${window.location.protocol}//${window.location.hostname}:4100`;
  }
  try {
    const url = new URL(configured);
    if (!isLocalHostname(url.hostname)) {
      return configured;
    }
    return `${url.protocol}//${window.location.hostname}:${url.port || "4100"}`;
  } catch {
    return configured;
  }
}

function isAuthEndpoint(path: string): boolean {
  return path.startsWith("/api/auth/");
}

function notifySessionExpired(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

function normalizeApiBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/$/, "");
  return normalized || null;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function readApiPayload<T>(
  response: Response
): Promise<{ data?: T; error?: { code?: string; message: string } }> {
  const text = await response.text();
  if (!text) {
    return response.ok ? {} : { error: { message: response.statusText || "Request failed" } };
  }
  try {
    return JSON.parse(text) as { data?: T; error?: { code?: string; message: string } };
  } catch {
    return { error: { message: response.ok ? "Invalid JSON response" : response.statusText || "Request failed" } };
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

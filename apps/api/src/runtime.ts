import type { FastifyRequest } from "fastify";

export function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function descCreated<T extends { createdAt: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function descUpdated<T extends { updatedAt: string }>(a: T, b: T): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function pathOnly(url: string): string {
  return url.split("?")[0] ?? url;
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return payloadRecord(parsed);
    } catch {
      return { raw: payload };
    }
  }
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { raw: payload };
}

export function round(value: number): number {
  return Number(value.toFixed(2));
}

export function webhookSignature(request: FastifyRequest): string | undefined {
  return (
    headerValue(request.headers["stripe-signature"]) ??
    headerValue(request.headers["x-webhook-signature"]) ??
    headerValue(request.headers["x-payment-signature"])
  );
}

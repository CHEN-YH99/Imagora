import { randomUUID } from "node:crypto";
import type { StoreData } from "@imagora/shared";
import type { FastifyRequest } from "fastify";
import type { HttpMetricsSnapshot } from "./runtime-state.js";
import { descUpdated, envNumber, pathOnly } from "./runtime.js";

export type OperationalIncidentSeverity = "info" | "warning" | "critical";
export type OperationalArea = "generation" | "payments" | "http" | "system";

export interface OperationalIncidentInput {
  severity: OperationalIncidentSeverity;
  area: OperationalArea;
  message: string;
  errorCode?: string | null;
  requestId?: string | null;
  userId?: string | null;
  taskId?: string | null;
  orderId?: string | null;
  route?: string | null;
}

interface ObservabilityRuntimeOptions {
  store: {
    update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T>;
  };
  runtimeState: {
    recordHttpMetric(route: string, statusCode: number, durationMs: number): Promise<void>;
    httpMetricsSnapshot(): Promise<HttpMetricsSnapshot>;
  };
}

export interface ObservabilityRuntime {
  recordRequestMetric(request: FastifyRequest, statusCode: number): Promise<void>;
  recordHttpIncident(
    request: FastifyRequest,
    input: Pick<OperationalIncidentInput, "severity" | "message" | "errorCode" | "taskId" | "orderId">
  ): Promise<void>;
  recordOperationalIncident(data: StoreData, input: OperationalIncidentInput): void;
  httpMetricsSnapshot(): Promise<HttpMetricsSnapshot>;
  routeLabel(request: FastifyRequest): string;
  stringDetail(details: Record<string, unknown> | undefined, key: string): string | null;
}

export function createObservabilityRuntime(options: ObservabilityRuntimeOptions): ObservabilityRuntime {
  async function recordRequestMetric(request: FastifyRequest, statusCode: number): Promise<void> {
    const route = routeLabel(request);
    const durationMs = Math.max(0, Date.now() - (request.startedAt ?? Date.now()));
    try {
      await options.runtimeState.recordHttpMetric(route, statusCode, durationMs);
    } catch (error) {
      request.log.error({ error, route }, "Runtime HTTP metrics update failed");
    }
  }

  async function recordHttpIncident(
    request: FastifyRequest,
    input: Pick<OperationalIncidentInput, "severity" | "message" | "errorCode" | "taskId" | "orderId">
  ): Promise<void> {
    try {
      await options.store.update((data) => {
        recordOperationalIncident(data, {
          severity: input.severity,
          area: "http",
          message: input.message,
          errorCode: input.errorCode,
          requestId: request.requestId ?? null,
          userId: request.userId ?? null,
          taskId: input.taskId ?? null,
          orderId: input.orderId ?? null,
          route: routeLabel(request)
        });
      });
    } catch {
      request.log.warn({ errorCode: "INCIDENT_RECORD_FAILED" }, "Operational incident record failed");
    }
  }

  function recordOperationalIncident(data: StoreData, input: OperationalIncidentInput): void {
    data.operationalIncidents ??= [];
    const now = new Date().toISOString();
    const existing = data.operationalIncidents.find((incident) => {
      if (incident.status !== "OPEN" || incident.errorCode !== (input.errorCode ?? null)) {
        return false;
      }
      if (input.taskId) {
        return incident.taskId === input.taskId;
      }
      if (input.orderId) {
        return incident.orderId === input.orderId;
      }
      return input.requestId ? incident.requestId === input.requestId : false;
    });

    if (existing) {
      existing.severity = input.severity;
      existing.message = sanitizeOperationalMessage(input.message);
      existing.requestId = input.requestId ?? existing.requestId;
      existing.userId = input.userId ?? existing.userId;
      existing.route = input.route ?? existing.route;
      existing.updatedAt = now;
      return;
    }

    data.operationalIncidents.push({
      id: randomUUID(),
      severity: input.severity,
      area: input.area,
      status: "OPEN",
      message: sanitizeOperationalMessage(input.message),
      errorCode: input.errorCode ?? null,
      requestId: input.requestId ?? null,
      userId: input.userId ?? null,
      taskId: input.taskId ?? null,
      orderId: input.orderId ?? null,
      route: input.route ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null
    });
    data.operationalIncidents = data.operationalIncidents
      .sort(descUpdated)
      .slice(0, envNumber("INCIDENT_RETENTION_MAX", 100));
  }

  function httpMetricsSnapshot(): Promise<HttpMetricsSnapshot> {
    return options.runtimeState.httpMetricsSnapshot();
  }

  return {
    recordRequestMetric,
    recordHttpIncident,
    recordOperationalIncident,
    httpMetricsSnapshot,
    routeLabel,
    stringDetail
  };
}

function routeLabel(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? pathOnly(request.url)}`;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeOperationalMessage(message: string): string {
  return message
    .replace(/(password|passwd|token|captcha|secret|api[_-]?key|authorization)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .slice(0, 280);
}

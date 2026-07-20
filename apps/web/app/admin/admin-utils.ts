import type { Order } from "../../lib/api";
import type { AdminOrderQuery, SelectedDetail } from "./admin-types";

export function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function filterValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toApiDateTime(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildOrderQueryKey(query: AdminOrderQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

function compareOrderCreatedDesc(a: Order, b: Order): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function mergeOrderCache(current: Order[], incoming: Order[]): Order[] {
  const byId = new Map<string, Order>(current.map((order) => [order.id, order]));
  for (const order of incoming) {
    byId.set(order.id, order);
  }
  return Array.from(byId.values()).sort(compareOrderCreatedDesc);
}

export function orderMatchesQuery(order: Order, query: AdminOrderQuery): boolean {
  if (query.status && order.status !== query.status) {
    return false;
  }
  if (query.userId && order.userId !== query.userId) {
    return false;
  }
  if (query.orderNo && !order.orderNo.toLowerCase().includes(query.orderNo.toLowerCase())) {
    return false;
  }

  const createdAt = Date.parse(order.createdAt);
  const createdFrom = query.createdFrom ? Date.parse(query.createdFrom) : null;
  const createdTo = query.createdTo ? Date.parse(query.createdTo) : null;
  if (Number.isNaN(createdAt)) {
    return createdFrom === null && createdTo === null;
  }
  if (createdFrom !== null && createdAt < createdFrom) {
    return false;
  }
  if (createdTo !== null && createdAt > createdTo) {
    return false;
  }
  return true;
}

export function detailDialogLabel(kind: SelectedDetail["kind"]): string {
  switch (kind) {
    case "user":
      return "用户";
    case "task":
      return "任务";
    case "image":
      return "图片";
    case "order":
      return "订单";
    default:
      return "详情";
  }
}

export function formatMilliseconds(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} 秒`;
  }
  return `${value} ms`;
}

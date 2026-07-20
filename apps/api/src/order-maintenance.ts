import type { createPaymentProvider } from "@imagora/payments";
import {
  DEFAULT_PENDING_TASK_TIMEOUT_MS,
  DEFAULT_RUNNING_TASK_TIMEOUT_MS,
  expireCredits,
  runGenerationMaintenance,
  type Order,
  type StoreData
} from "@imagora/shared";
import { envNumber } from "./runtime.js";

export interface OrderMaintenanceResult {
  closedExpiredOrders: number;
  reconciledPaidOrders: number;
  reconciledPaymentEvents: number;
  expiredCredits: number;
  failedPendingGenerationTasks: number;
  failedRunningGenerationTasks: number;
  reconciledGenerationRefunds: number;
  refundedGenerationCredits: number;
}

interface PaymentSucceededInput {
  provider: string;
  providerEventId: string;
  orderId: string;
  orderNo: string;
  eventType: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
  requestId?: string | null;
  route?: string | null;
  payload: Record<string, unknown>;
}

interface OrderMaintenanceRuntimeOptions {
  store: {
    read(): Promise<StoreData>;
    update<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T>;
  };
  paymentProvider: ReturnType<typeof createPaymentProvider>;
  closeExpiredPendingOrders(data: StoreData, now: string): number;
  reconcileSucceededPaymentEvents(data: StoreData, now: string): number;
  reconcilePaidOrderCredits(data: StoreData): number;
  applyPaymentSucceeded(
    data: StoreData,
    input: PaymentSucceededInput
  ): { credited: boolean; balanceAfter: number; reason: string | null };
  onLog(level: "warn" | "error", details: Record<string, unknown>, message: string): void;
}

export interface OrderMaintenanceRuntime {
  generationMaintenanceOptions(): { pendingTimeoutMs: number; runningTimeoutMs: number };
  runOrderMaintenance(data: StoreData): OrderMaintenanceResult;
  startBackgroundGenerationMaintenance(): void;
  startBackgroundOrderMaintenance(): void;
  startBackgroundProviderReconcile(): void;
}

export function createOrderMaintenanceRuntime(options: OrderMaintenanceRuntimeOptions): OrderMaintenanceRuntime {
  function generationMaintenanceOptions(): { pendingTimeoutMs: number; runningTimeoutMs: number } {
    return {
      pendingTimeoutMs: envNumber("GENERATION_PENDING_TIMEOUT_MS", DEFAULT_PENDING_TASK_TIMEOUT_MS),
      runningTimeoutMs: envNumber("GENERATION_RUNNING_TIMEOUT_MS", DEFAULT_RUNNING_TASK_TIMEOUT_MS)
    };
  }

  function runOrderMaintenance(data: StoreData): OrderMaintenanceResult {
    const now = new Date().toISOString();
    const expiredCredits = expireCredits(data);
    const generationMaintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
    const closedExpiredOrders = options.closeExpiredPendingOrders(data, now);
    const reconciledPaymentEvents = options.reconcileSucceededPaymentEvents(data, now);
    const reconciledPaidOrders = options.reconcilePaidOrderCredits(data);
    return {
      closedExpiredOrders,
      reconciledPaidOrders,
      reconciledPaymentEvents,
      expiredCredits,
      failedPendingGenerationTasks: generationMaintenance.failedPendingTasks,
      failedRunningGenerationTasks: generationMaintenance.failedRunningTasks,
      reconciledGenerationRefunds: generationMaintenance.reconciledRefunds,
      refundedGenerationCredits: generationMaintenance.refundedCredits
    };
  }

  function startBackgroundGenerationMaintenance(): void {
    const intervalMs = envNumber("GENERATION_MAINTENANCE_INTERVAL_MS", 60_000);
    if (intervalMs <= 0) {
      return;
    }

    const timer = setInterval(() => {
      options.store
        .update((data) => {
          const generationMaintenance = runGenerationMaintenance(data, generationMaintenanceOptions());
          const expiredCredits = expireCredits(data);
          if (
            generationMaintenance.failedPendingTasks ||
            generationMaintenance.failedRunningTasks ||
            generationMaintenance.reconciledRefunds ||
            expiredCredits
          ) {
            options.onLog(
              "warn",
              {
                failedPendingTasks: generationMaintenance.failedPendingTasks,
                failedRunningTasks: generationMaintenance.failedRunningTasks,
                reconciledGenerationRefunds: generationMaintenance.reconciledRefunds,
                refundedGenerationCredits: generationMaintenance.refundedCredits,
                expiredCredits
              },
              "background generation maintenance reconciled tasks"
            );
          }
        })
        .catch((error) => {
          options.onLog("error", { err: error }, "background generation maintenance failed");
        });
    }, intervalMs);

    timer.unref();
  }

  function startBackgroundOrderMaintenance(): void {
    const intervalMs = envNumber("ORDER_MAINTENANCE_INTERVAL_MS", 60_000);
    if (intervalMs <= 0) {
      return;
    }

    const timer = setInterval(() => {
      options.store
        .update((data) => {
          const maintenance = runOrderMaintenance(data);
          if (
            maintenance.closedExpiredOrders ||
            maintenance.reconciledPaymentEvents ||
            maintenance.reconciledPaidOrders
          ) {
            options.onLog(
              "warn",
              {
                closedExpiredOrders: maintenance.closedExpiredOrders,
                reconciledPaymentEvents: maintenance.reconciledPaymentEvents,
                reconciledPaidOrders: maintenance.reconciledPaidOrders
              },
              "background order maintenance reconciled orders"
            );
          }
        })
        .catch((error) => {
          options.onLog("error", { err: error }, "background order maintenance failed");
        });
    }, intervalMs);

    timer.unref();
  }

  async function reconcilePendingOrdersWithProvider(): Promise<void> {
    const expiresMs = envNumber("ORDER_PENDING_TTL_MINUTES", 30) * 60 * 1000;
    if (expiresMs <= 0) {
      return;
    }
    const cutoff = Date.now() - expiresMs;
    const snapshot = await options.store.read();
    const staleOrders = snapshot.orders.filter(
      (order) =>
        order.status === "PENDING" &&
        order.paymentProvider === options.paymentProvider.name &&
        new Date(order.createdAt).getTime() <= cutoff
    );
    if (staleOrders.length === 0) {
      return;
    }

    let reconciled = 0;
    for (const order of staleOrders) {
      const recovered = await recoverPendingOrder(order);
      if (recovered) {
        reconciled += 1;
      }
    }
    if (reconciled > 0) {
      options.onLog("warn", { reconciled }, "background provider reconcile recovered paid orders");
    }
  }

  async function recoverPendingOrder(order: Order): Promise<boolean> {
    let result: Awaited<ReturnType<typeof options.paymentProvider.retrieveOrderPaymentStatus>>;
    try {
      result = await options.paymentProvider.retrieveOrderPaymentStatus({
        orderId: order.id,
        orderNo: order.orderNo,
        paymentIntentId: order.paymentIntentId,
        amountCents: order.amountCents,
        currency: order.currency
      });
    } catch (error) {
      options.onLog("error", { err: error, orderId: order.id }, "order payment status retrieve threw");
      return false;
    }
    if (result.status !== "paid" || !result.event) {
      return false;
    }

    const event = result.event;
    try {
      const applied = await options.store.update((data) =>
        options.applyPaymentSucceeded(data, {
          provider: event.provider,
          providerEventId: event.providerEventId,
          orderId: event.orderId,
          orderNo: event.orderNo,
          eventType: event.eventType,
          amountCents: event.amountCents,
          currency: event.currency,
          paymentIntentId: event.paymentIntentId,
          route: "background:reconcile-pending-orders",
          payload: { source: "provider-reconcile", reconciledAt: new Date().toISOString() }
        })
      );
      if (applied.credited) {
        options.onLog(
          "warn",
          { orderId: order.id, balanceAfter: applied.balanceAfter },
          "recovered lost-webhook order via provider reconcile"
        );
        return true;
      }
      if (applied.reason && applied.reason !== "DUPLICATE_EVENT") {
        options.onLog(
          "error",
          { orderId: order.id, reason: applied.reason },
          "provider reconcile found paid order but could not credit"
        );
      }
    } catch (error) {
      options.onLog("error", { err: error, orderId: order.id }, "provider reconcile apply failed");
    }
    return false;
  }

  function startBackgroundProviderReconcile(): void {
    const intervalMs = envNumber("ORDER_PROVIDER_RECONCILE_INTERVAL_MS", 300_000);
    if (intervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      reconcilePendingOrdersWithProvider().catch((error) => {
        options.onLog("error", { err: error }, "background provider reconcile failed");
      });
    }, intervalMs);
    timer.unref();
  }

  return {
    generationMaintenanceOptions,
    runOrderMaintenance,
    startBackgroundGenerationMaintenance,
    startBackgroundOrderMaintenance,
    startBackgroundProviderReconcile
  };
}

import { expireCredits, runGenerationMaintenance, type GenerationMaintenanceResult } from "@imagora/shared";
import type { Store } from "./index.js";

type MaintenanceStore = Pick<
  Store,
  "readGenerationMaintenanceCandidates" | "readCreditExpiryUsers" | "trimOperationalIncidents" | "updateScoped"
>;

export interface GenerationMaintenanceRunOptions {
  pendingTimeoutMs: number;
  runningTimeoutMs: number;
  taskBatchSize?: number;
  creditUserBatchSize?: number;
  incidentRetentionMax?: number;
}

export type GenerationMaintenanceRunResult = GenerationMaintenanceResult & { expiredCredits: number };

export interface GenerationMaintenanceRunner {
  run(options: GenerationMaintenanceRunOptions): Promise<GenerationMaintenanceRunResult>;
}

/** 每个实例独立轮转任务和用户；重叠调用共享当前 Promise，并使用首次调用的选项。 */
export function createGenerationMaintenanceRunner(store: MaintenanceStore): GenerationMaintenanceRunner {
  let taskCursor: string | undefined;
  let userCursor: string | undefined;
  let inFlight: Promise<GenerationMaintenanceRunResult> | null = null;

  async function execute(options: GenerationMaintenanceRunOptions): Promise<GenerationMaintenanceRunResult> {
    const taskBatchSize = batchSize(options.taskBatchSize ?? 100);
    const creditUserBatchSize = batchSize(options.creditUserBatchSize ?? 10);
    validateTimeout(options.pendingTimeoutMs);
    validateTimeout(options.runningTimeoutMs);
    if (
      options.incidentRetentionMax !== undefined &&
      (!Number.isSafeInteger(options.incidentRetentionMax) || options.incidentRetentionMax < 0)
    ) {
      throw new RangeError("Incident retention must be a non-negative safe integer");
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const pendingBefore = timeoutCutoff(nowMs, options.pendingTimeoutMs);
    const runningBefore = timeoutCutoff(nowMs, options.runningTimeoutMs);
    const tasks = await rotatingBatch(
      taskCursor,
      taskBatchSize,
      (afterId) =>
        store.readGenerationMaintenanceCandidates({ pendingBefore, runningBefore, afterId, limit: taskBatchSize }),
      (task) => task.id
    );
    // 即使这批缺账户或事务失败也前进，坏数据会在回绕时重试，不挡住后面的候选。
    taskCursor = tasks.at(-1)?.id;
    const generation = tasks.length
      ? await store.updateScoped(
          {
            generationTasks: { ids: tasks.map((task) => task.id) },
            creditAccounts: { userIds: [...new Set(tasks.map((task) => task.userId))] },
            creditLedgerEntries: "loadedTasks"
          },
          (data) =>
            runGenerationMaintenance(data, {
              now,
              pendingTimeoutMs: options.pendingTimeoutMs,
              runningTimeoutMs: options.runningTimeoutMs
            })
        )
      : { failedPendingTasks: 0, failedRunningTasks: 0, reconciledRefunds: 0, refundedCredits: 0 };

    const userIds = await rotatingBatch(
      userCursor,
      creditUserBatchSize,
      (afterUserId) => store.readCreditExpiryUsers({ now, afterUserId, limit: creditUserBatchSize }),
      (userId) => userId
    );
    userCursor = userIds.at(-1);
    const expiredCredits = userIds.length
      ? await store.updateScoped({ creditAccounts: { userIds }, creditLedgerEntries: { userIds } }, (data) =>
          expireCredits(data, now)
        )
      : 0;
    if (options.incidentRetentionMax !== undefined) {
      await store.trimOperationalIncidents(options.incidentRetentionMax);
    }
    return { ...generation, expiredCredits };
  }

  return {
    run(options) {
      if (inFlight) return inFlight;
      inFlight = execute({ ...options }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}

/** 最多两次有界读取；尾页不足时从头补足，并排除本批重复项。 */
async function rotatingBatch<T>(
  cursor: string | undefined,
  limit: number,
  read: (after: string | undefined) => Promise<T[]>,
  key: (item: T) => string
): Promise<T[]> {
  const selected: T[] = [];
  const ids = new Set<string>();
  const append = (items: T[]) => {
    for (const item of items) {
      if (selected.length >= limit) break;
      const id = key(item);
      if (ids.has(id)) continue;
      ids.add(id);
      selected.push(item);
    }
  };
  append(await read(cursor));
  if (cursor !== undefined && selected.length < limit) append(await read(undefined));
  return selected;
}

function batchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new RangeError("Maintenance batch limit must be an integer between 1 and 1000");
  }
  return value;
}

function validateTimeout(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Maintenance timeout must be finite and non-negative");
}

function timeoutCutoff(nowMs: number, timeoutMs: number): string | undefined {
  return timeoutMs > 0 ? new Date(nowMs - timeoutMs).toISOString() : undefined;
}

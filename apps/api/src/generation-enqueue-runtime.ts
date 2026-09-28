import type { Store } from "@imagora/database";
import type { GenerationQueue } from "@imagora/queue";
import type { GenerationTask } from "@imagora/shared";

type PendingTask = Pick<GenerationTask, "id" | "userId" | "createdAt">;

export interface GenerationEnqueueAttempt {
  enqueued: boolean;
  errorMessage: string | null;
}

export interface GenerationEnqueueReconciliation {
  attempted: number;
  enqueued: number;
  failed: number;
}

interface GenerationEnqueueRuntimeOptions {
  store: Pick<Store, "readPendingGenerationTasks">;
  queue: Pick<GenerationQueue, "enqueueGenerationTask">;
  intervalMs: number;
  batchSize: number;
  failureLogIntervalMs?: number;
  onLog?: (level: "info" | "warn" | "error", details: Record<string, unknown>, message: string) => void;
}

export interface GenerationEnqueueRuntime {
  enqueueTask(task: PendingTask): Promise<GenerationEnqueueAttempt>;
  reconcilePendingTasks(): Promise<GenerationEnqueueReconciliation>;
  start(): void;
  stop(): Promise<void>;
}

export function createGenerationEnqueueRuntime(options: GenerationEnqueueRuntimeOptions): GenerationEnqueueRuntime {
  const intervalMs = positiveInteger(options.intervalMs, 5_000);
  const batchSize = positiveInteger(options.batchSize, 100);
  const failureLogIntervalMs = positiveInteger(options.failureLogIntervalMs ?? 60_000, 60_000);
  let timer: NodeJS.Timeout | null = null;
  let activeReconciliation: Promise<GenerationEnqueueReconciliation> | null = null;
  const activeImmediateEnqueues = new Set<Promise<GenerationEnqueueAttempt>>();
  let reconciliationCursor: Pick<PendingTask, "createdAt" | "id"> | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let lastImmediateFailureLogAt = 0;
  let immediateEnqueueHadFailures = false;
  let lastFailureLogAt = 0;
  let reconciliationHadFailures = false;

  async function attemptEnqueue(task: PendingTask): Promise<GenerationEnqueueAttempt> {
    try {
      await options.queue.enqueueGenerationTask({
        taskId: task.id,
        userId: task.userId,
        requestedAt: task.createdAt
      });
      return { enqueued: true, errorMessage: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Generation queue enqueue failed";
      return { enqueued: false, errorMessage: message };
    }
  }

  async function runImmediateEnqueue(task: PendingTask): Promise<GenerationEnqueueAttempt> {
    const attempt = await attemptEnqueue(task);
    if (!attempt.enqueued) {
      const now = Date.now();
      if (!immediateEnqueueHadFailures || now - lastImmediateFailureLogAt >= failureLogIntervalMs) {
        options.onLog?.("warn", { taskId: task.id, error: attempt.errorMessage }, "generation task enqueue deferred");
        lastImmediateFailureLogAt = now;
      }
      immediateEnqueueHadFailures = true;
    } else if (immediateEnqueueHadFailures) {
      options.onLog?.("info", { taskId: task.id }, "generation task enqueue recovered");
      immediateEnqueueHadFailures = false;
    }
    return attempt;
  }

  function enqueueTask(task: PendingTask): Promise<GenerationEnqueueAttempt> {
    if (stopping) {
      return Promise.resolve({
        enqueued: false,
        errorMessage: "Generation enqueue runtime is stopping"
      });
    }

    const trackedEnqueue = runImmediateEnqueue(task);
    activeImmediateEnqueues.add(trackedEnqueue);
    return trackedEnqueue.finally(() => {
      activeImmediateEnqueues.delete(trackedEnqueue);
    });
  }

  function reconcilePendingTasks(): Promise<GenerationEnqueueReconciliation> {
    if (activeReconciliation) {
      return activeReconciliation;
    }
    if (stopping) {
      return Promise.resolve({ attempted: 0, enqueued: 0, failed: 0 });
    }

    activeReconciliation = (async () => {
      const pendingTasks = await selectPendingTasks();
      const attempts = await Promise.all(pendingTasks.map((task) => attemptEnqueue(task)));
      const lastAttemptedTask = pendingTasks.at(-1);
      if (lastAttemptedTask) {
        reconciliationCursor = {
          createdAt: lastAttemptedTask.createdAt,
          id: lastAttemptedTask.id
        };
      }
      const result = {
        attempted: attempts.length,
        enqueued: attempts.filter((attempt) => attempt.enqueued).length,
        failed: attempts.filter((attempt) => !attempt.enqueued).length
      };

      if (result.failed > 0) {
        const now = Date.now();
        if (!reconciliationHadFailures || now - lastFailureLogAt >= failureLogIntervalMs) {
          options.onLog?.("error", result, "pending generation enqueue reconciliation had failures");
          lastFailureLogAt = now;
        }
        reconciliationHadFailures = true;
      } else if (reconciliationHadFailures) {
        options.onLog?.("info", result, "pending generation enqueue reconciliation recovered");
        reconciliationHadFailures = false;
      } else if (result.enqueued > 0) {
        options.onLog?.("info", result, "pending generation tasks reconciled to queue");
      }
      return result;
    })().finally(() => {
      activeReconciliation = null;
    });

    return activeReconciliation;
  }

  // 游标之后取一批；不足一批时从头补齐（即回绕到游标及之前的任务），只按需定向读取 PENDING 任务。
  async function selectPendingTasks(): Promise<PendingTask[]> {
    const cursor = reconciliationCursor;
    const afterCursor = cursor
      ? await options.store.readPendingGenerationTasks({ after: cursor, limit: batchSize })
      : [];
    if (afterCursor.length >= batchSize) {
      return afterCursor;
    }
    const selected = new Set(afterCursor.map((task) => task.id));
    const fromStart = await options.store.readPendingGenerationTasks({ limit: batchSize });
    return [...afterCursor, ...fromStart.filter((task) => !selected.has(task.id))].slice(0, batchSize);
  }

  function start(): void {
    if (timer || stopping) {
      return;
    }
    void reconcilePendingTasks().catch((error) => {
      options.onLog?.(
        "error",
        { error: error instanceof Error ? error.message : String(error) },
        "startup generation enqueue reconciliation failed"
      );
    });
    timer = setInterval(() => {
      void reconcilePendingTasks().catch((error) => {
        options.onLog?.(
          "error",
          { error: error instanceof Error ? error.message : String(error) },
          "background generation enqueue reconciliation failed"
        );
      });
    }, intervalMs);
    timer.unref();
  }

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stopPromise = Promise.all([
      ...(activeReconciliation ? [activeReconciliation] : []),
      ...activeImmediateEnqueues
    ]).then(() => undefined);
    return stopPromise;
  }

  return {
    enqueueTask,
    reconcilePendingTasks,
    start,
    stop
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

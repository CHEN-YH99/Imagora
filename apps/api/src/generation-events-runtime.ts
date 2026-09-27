import type { GenerationStreamData, Store } from "@imagora/database";
import { AppError, type GenerationTask } from "@imagora/shared";

export interface GenerationStreamUpdate {
  task: GenerationTask;
  images: GenerationStreamData["generatedImages"];
  creditLedgerEntries: GenerationStreamData["creditLedgerEntries"];
}

interface Subscriber {
  token: string;
  taskId: string;
  version: string;
  heartbeatAt: number;
  pending?: GenerationStreamUpdate | null;
  error?: unknown;
  closed: boolean;
  wake?: () => void;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
}

/** 一个 API 进程只维护一个批量读取循环；慢连接仅保留最新快照。 */
export function createGenerationEventsRuntime(
  store: Pick<Store, "readGenerationStream">,
  options: { pollIntervalMs?: number; heartbeatMs?: number } = {}
) {
  const subscribers = new Set<Subscriber>();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;

  function remove(subscriber: Subscriber) {
    subscribers.delete(subscriber);
    subscriber.closed = true;
    subscriber.wake?.();
    if (!subscribers.size && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function fail(subscriber: Subscriber, error: unknown) {
    subscriber.error = error;
    subscriber.pending = undefined;
    subscriber.rejectReady(error);
    remove(subscriber);
  }

  function schedule(delayMs: number) {
    if (closed || timer || inFlight || !subscribers.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = poll().finally(() => {
        inFlight = undefined;
        schedule(pollIntervalMs);
      });
    }, delayMs);
  }

  async function poll() {
    const current = [...subscribers];
    try {
      const data = await store.readGenerationStream({
        taskIds: [...new Set(current.map((subscriber) => subscriber.taskId))],
        sessionTokens: [...new Set(current.map((subscriber) => subscriber.token))]
      });
      const sessions = new Map(data.sessions.map((session) => [session.token, session]));
      const updates = new Map(
        data.generationTasks.map((task) => [
          task.id,
          {
            task,
            images: data.generatedImages.filter(
              (image) => image.taskId === task.id && image.userId === task.userId && !image.deletedAt
            ),
            creditLedgerEntries: data.creditLedgerEntries.filter(
              (entry) => entry.sourceId === task.id && entry.userId === task.userId
            )
          }
        ])
      );
      const now = Date.now();
      for (const subscriber of current) {
        if (subscriber.closed) continue;
        const session = sessions.get(subscriber.token);
        if (!session || Date.parse(session.expiresAt) <= now) {
          fail(subscriber, new AppError("UNAUTHORIZED", "Invalid or expired session", 401));
          continue;
        }
        if (session.userStatus !== "ACTIVE") {
          fail(subscriber, new AppError("FORBIDDEN", "User is not active", 403));
          continue;
        }
        const update = updates.get(subscriber.taskId);
        if (!update || update.task.userId !== session.userId) {
          fail(subscriber, new AppError("NOT_FOUND", "Generation task was not found", 404));
          continue;
        }
        const version = [update.task.updatedAt, update.task.progress?.sequence ?? 0, update.task.status].join(":");
        if (version !== subscriber.version) {
          subscriber.pending = update;
          subscriber.version = version;
          subscriber.heartbeatAt = now;
        } else if (subscriber.pending === undefined && now - subscriber.heartbeatAt >= heartbeatMs) {
          subscriber.pending = null;
          subscriber.heartbeatAt = now;
        }
        subscriber.resolveReady();
        subscriber.wake?.();
        if (!["PENDING", "RUNNING"].includes(update.task.status)) remove(subscriber);
      }
    } catch (error) {
      for (const subscriber of current) {
        if (!subscriber.closed) fail(subscriber, error);
      }
    }
  }

  function subscribe(token: string, taskId: string) {
    if (closed) throw new AppError("INTERNAL_ERROR", "Generation streams are closing", 503);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const subscriber: Subscriber = {
      token,
      taskId,
      version: "",
      heartbeatAt: Date.now(),
      closed: false,
      resolveReady,
      rejectReady
    };
    const close = () => {
      subscriber.pending = undefined;
      subscriber.rejectReady(new AppError("INTERNAL_ERROR", "Generation stream closed", 503));
      remove(subscriber);
    };
    const events = (async function* () {
      try {
        while (true) {
          if (subscriber.error) throw subscriber.error;
          if (subscriber.pending !== undefined) {
            const update = subscriber.pending;
            subscriber.pending = undefined;
            yield update;
          } else if (subscriber.closed) {
            return;
          } else {
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
            });
            subscriber.wake = undefined;
          }
        }
      } finally {
        close();
      }
    })();
    subscribers.add(subscriber);
    schedule(0);
    return { ready, events, close };
  }

  return {
    subscribe,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const subscriber of subscribers) {
        fail(subscriber, new AppError("INTERNAL_ERROR", "Generation streams are closing", 503));
      }
      await inFlight;
    }
  };
}

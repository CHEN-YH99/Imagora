import { generationTaskVersion, type GenerationStreamData, type Store } from "@imagora/database";
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
  const taskSubscriberCounts = new Map<string, number>();
  const snapshots = new Map<string, GenerationStreamUpdate>();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;

  function remove(subscriber: Subscriber) {
    if (subscribers.delete(subscriber)) {
      const remaining = (taskSubscriberCounts.get(subscriber.taskId) ?? 1) - 1;
      if (remaining) taskSubscriberCounts.set(subscriber.taskId, remaining);
      else {
        taskSubscriberCounts.delete(subscriber.taskId);
        snapshots.delete(subscriber.taskId);
      }
    }
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
      const taskIds = [...new Set(current.map((subscriber) => subscriber.taskId))];
      // 保留发起读取时的快照；等待期间断连/重新订阅不能清空本批次省略的图片与退款。
      const requestedSnapshots = new Map(snapshots);
      const knownTaskVersions = Object.fromEntries(
        taskIds.flatMap((id) => {
          const previous = requestedSnapshots.get(id);
          return previous ? [[id, generationTaskVersion(previous.task)]] : [];
        })
      );
      const data = await store.readGenerationStream({
        taskIds,
        sessionTokens: [...new Set(current.map((subscriber) => subscriber.token))],
        ...(Object.keys(knownTaskVersions).length ? { knownTaskVersions } : {})
      });
      const sessions = new Map(data.sessions.map((session) => [session.token, session]));
      const imagesByTask = new Map<string, GenerationStreamData["generatedImages"]>();
      for (const image of data.generatedImages) {
        const images = imagesByTask.get(image.taskId) ?? [];
        images.push(image);
        imagesByTask.set(image.taskId, images);
      }
      const entriesByTask = new Map<string, GenerationStreamData["creditLedgerEntries"]>();
      for (const entry of data.creditLedgerEntries) {
        const entries = entriesByTask.get(entry.sourceId) ?? [];
        entries.push(entry);
        entriesByTask.set(entry.sourceId, entries);
      }
      const updates = new Map(
        data.generationTasks.map((task) => {
          const previous = requestedSnapshots.get(task.id);
          const update =
            previous && generationTaskVersion(previous.task) === generationTaskVersion(task)
              ? previous
              : {
                  task,
                  images: (imagesByTask.get(task.id) ?? []).filter(
                    (image) => image.userId === task.userId && !image.deletedAt
                  ),
                  creditLedgerEntries: (entriesByTask.get(task.id) ?? []).filter(
                    (entry) => entry.userId === task.userId
                  )
                };
          snapshots.set(task.id, update);
          return [task.id, update] as const;
        })
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
        const version = generationTaskVersion(update.task);
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
      for (const id of snapshots.keys()) if (!taskSubscriberCounts.has(id)) snapshots.delete(id);
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
    taskSubscriberCounts.set(taskId, (taskSubscriberCounts.get(taskId) ?? 0) + 1);
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
      snapshots.clear();
    }
  };
}

import { Queue, Worker as BullWorker, type ConnectionOptions, type JobsOptions } from "bullmq";

export interface GenerationQueueJob {
  taskId: string;
  userId: string;
  requestedAt: string;
}

export interface GenerationQueue {
  provider: "inline" | "bullmq";
  enqueueGenerationTask(job: GenerationQueueJob): Promise<void>;
  close(): Promise<void>;
}

export interface GenerationWorkerHandle {
  close(): Promise<void>;
}

export type GenerationJobProcessor = (job: GenerationQueueJob) => Promise<void>;

export interface GenerationWorkerSettings {
  concurrency: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
}

export interface GenerationQueueProducerSettings {
  commandTimeoutMs: number;
  maxRetriesPerRequest: number;
}

export interface GenerationQueueClient {
  add(name: string, job: GenerationQueueJob, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type GenerationQueueClientFactory = (
  redisUrl: string,
  settings: GenerationQueueProducerSettings
) => GenerationQueueClient;

export class InlineGenerationQueue implements GenerationQueue {
  readonly provider = "inline";

  async enqueueGenerationTask(_job: GenerationQueueJob): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}

export class BullMqGenerationQueue implements GenerationQueue {
  readonly provider = "bullmq";
  private queue: GenerationQueueClient | null = null;
  private closed = false;

  constructor(
    private readonly redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    private readonly settings = resolveGenerationQueueProducerSettings(),
    private readonly queueFactory: GenerationQueueClientFactory = createBullMqQueueClient
  ) {}

  async enqueueGenerationTask(job: GenerationQueueJob): Promise<void> {
    if (this.closed) {
      throw new Error("Generation queue is closed");
    }

    const queue = this.queue ?? this.createQueue();
    try {
      await queue.add("generate-image", job, generationQueueJobOptions(job));
    } catch (error) {
      await this.invalidateQueue(queue);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const queue = this.queue;
    this.queue = null;
    if (queue) {
      await queue.close();
    }
  }

  private createQueue(): GenerationQueueClient {
    const queue = this.queueFactory(this.redisUrl, this.settings);
    queue.on("error", () => undefined);
    this.queue = queue;
    return queue;
  }

  private async invalidateQueue(queue: GenerationQueueClient): Promise<void> {
    if (this.queue !== queue) {
      return;
    }
    this.queue = null;
    try {
      await queue.close();
    } catch {
      // Preserve the enqueue failure; the broken client has already been detached.
    }
  }
}

function createBullMqQueueClient(redisUrl: string, settings: GenerationQueueProducerSettings): GenerationQueueClient {
  return new Queue<GenerationQueueJob>("generation", {
    connection: redisConnection(redisUrl, settings)
  });
}

export function createGenerationQueue(name = process.env.QUEUE_PROVIDER ?? "inline"): GenerationQueue {
  switch (name) {
    case "inline":
      return new InlineGenerationQueue();
    case "bullmq":
      return new BullMqGenerationQueue();
    default:
      throw new Error(`Unsupported queue provider: ${name}`);
  }
}

export function startGenerationWorker(
  processor: GenerationJobProcessor,
  redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"
): GenerationWorkerHandle {
  const settings = resolveGenerationWorkerSettings();
  const worker = new BullWorker<GenerationQueueJob>(
    "generation",
    async (job) => {
      await processor(job.data);
    },
    {
      connection: redisConnection(redisUrl, null),
      concurrency: settings.concurrency,
      lockDuration: settings.lockDurationMs,
      stalledInterval: settings.stalledIntervalMs,
      maxStalledCount: settings.maxStalledCount
    }
  );

  worker.on("failed", (job, error) => {
    console.error(`[imagora-queue] job ${job?.id ?? "unknown"} failed`, error);
  });

  return {
    async close() {
      await worker.close();
    }
  };
}

export function generationQueueJobOptions(job: GenerationQueueJob): JobsOptions {
  return {
    jobId: job.taskId,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200
  };
}

export function resolveGenerationQueueProducerSettings(
  env: Partial<Record<string, string | undefined>> = process.env
): GenerationQueueProducerSettings {
  return {
    commandTimeoutMs: readPositiveInt(env.GENERATION_QUEUE_COMMAND_TIMEOUT_MS, 2_000, 100, 30_000),
    maxRetriesPerRequest: 1
  };
}

export function resolveGenerationWorkerSettings(
  env: Partial<Record<string, string | undefined>> = process.env
): GenerationWorkerSettings {
  return {
    concurrency: readPositiveInt(env.WORKER_CONCURRENCY, 4, 1, 32),
    lockDurationMs: readPositiveInt(env.WORKER_LOCK_DURATION_MS, 300_000, 30_000, 30 * 60_000),
    stalledIntervalMs: readPositiveInt(env.WORKER_STALLED_INTERVAL_MS, 30_000, 5_000, 5 * 60_000),
    maxStalledCount: readPositiveInt(env.WORKER_MAX_STALLED_COUNT, 2, 1, 10)
  };
}

function redisConnection(
  redisUrl: string,
  producerSettings: GenerationQueueProducerSettings | null
): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.replace("/", "") || 0),
    maxRetriesPerRequest: producerSettings?.maxRetriesPerRequest ?? null,
    ...(producerSettings
      ? {
          commandTimeout: producerSettings.commandTimeoutMs,
          connectTimeout: producerSettings.commandTimeoutMs,
          enableOfflineQueue: false,
          retryStrategy: () => null
        }
      : {})
  };
}

function readPositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

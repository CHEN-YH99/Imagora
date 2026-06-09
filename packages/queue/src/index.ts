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
  private readonly queue: Queue<GenerationQueueJob>;

  constructor(redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.queue = new Queue<GenerationQueueJob>("generation", { connection: redisConnection(redisUrl) });
  }

  async enqueueGenerationTask(job: GenerationQueueJob): Promise<void> {
    const options: JobsOptions = {
      jobId: job.taskId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 200
    };
    await this.queue.add("generate-image", job, options);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
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
  const worker = new BullWorker<GenerationQueueJob>(
    "generation",
    async (job) => {
      await processor(job.data);
    },
    { connection: redisConnection(redisUrl) }
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

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.replace("/", "") || 0),
    maxRetriesPerRequest: null
  };
}

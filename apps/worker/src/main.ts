import { randomUUID } from "node:crypto";
import { createImageGenerationProvider } from "@imagora/ai-providers";
import { createStore } from "@imagora/database";
import { startGenerationWorker, type GenerationQueueJob } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import { createObjectStorage } from "@imagora/storage";
import type { GeneratedImage, GenerationTask, StoreData } from "@imagora/shared";

const store = createStore();
const provider = createImageGenerationProvider();
const storage = createObjectStorage();
const safety = createSafetyProvider();
const queueProvider = process.env.QUEUE_PROVIDER ?? "inline";
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2500);

console.log(`[imagora-worker] started with ${queueProvider} queue provider`);

if (queueProvider === "bullmq") {
  startGenerationWorker(processQueuedJob);
} else {
  console.log(`[imagora-worker] polling every ${pollIntervalMs}ms`);
  await tick();
  setInterval(() => {
    tick().catch((error) => {
      console.error("[imagora-worker] tick failed", error);
    });
  }, pollIntervalMs);
}

async function tick(): Promise<void> {
  await store.update(async (data) => {
    refundStaleRunningTasks(data);
    const task = data.generationTasks.find((item) => item.status === "PENDING");
    if (!task) {
      return;
    }
    await processTask(data, task);
  });
}

async function processQueuedJob(job: GenerationQueueJob): Promise<void> {
  const data = await store.read();
  refundStaleRunningTasks(data);
  const task = data.generationTasks.find((item) => item.id === job.taskId && item.status === "PENDING");
  if (!task) {
    return;
  }
  await processTask(data, task);
  await store.write(data);
}

async function processTask(data: StoreData, task: GenerationTask): Promise<void> {
  const now = new Date().toISOString();
  task.status = "RUNNING";
  task.startedAt = now;
  task.updatedAt = now;

  try {
    const result = await provider.generateImage({
      taskId: task.id,
      prompt: task.prompt,
      negativePrompt: task.negativePrompt,
      style: task.style,
      aspectRatio: task.aspectRatio,
      width: task.width,
      height: task.height,
      quantity: task.quantity,
      quality: task.quality,
      referenceImageUrl: task.referenceImageId
        ? data.referenceImages.find((image) => image.id === task.referenceImageId && !image.deletedAt)?.publicUrl
        : null
    });
    console.log(`[imagora-worker] task ${task.id} provider request ${result.providerRequestId}`);

    for (const image of result.images) {
      const safetyResult = await safety.checkImage({ mimeType: image.mimeType, bytes: image.bytes });
      if (safetyResult.status === "BLOCKED") {
        failTask(data, task, safetyResult.reasonCode, safetyResult.reasonMessage);
        return;
      }
      data.generatedImages.push(await createImage(task, image.index, image.bytes, image.mimeType));
    }
  } catch (error) {
    failTask(data, task, "PROVIDER_FAILED", error instanceof Error ? error.message : "Provider failed");
    return;
  }

  task.status = "SUCCEEDED";
  task.completedAt = new Date().toISOString();
  task.updatedAt = task.completedAt;
  console.log(`[imagora-worker] task ${task.id} completed with ${task.quantity} image(s)`);
}

function failTask(data: StoreData, task: GenerationTask, code: string, message: string): void {
  const now = new Date().toISOString();
  task.status = "FAILED";
  task.failureCode = code;
  task.failureMessage = message;
  task.completedAt = now;
  task.updatedAt = now;
  refundTask(data, task, "Task failed before image delivery");
  console.log(`[imagora-worker] task ${task.id} failed and refunded`);
}

function refundStaleRunningTasks(data: StoreData): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const task of data.generationTasks) {
    if (task.status !== "RUNNING" || !task.startedAt) {
      continue;
    }
    if (new Date(task.startedAt).getTime() < cutoff) {
      failTask(data, task, "WORKER_TIMEOUT", "Task exceeded worker timeout and was refunded");
    }
  }
}

function refundTask(data: StoreData, task: GenerationTask, remark: string): void {
  const idempotencyKey = `task-refund:${task.id}`;
  if (data.creditLedgerEntries.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    return;
  }
  const account = data.creditAccounts.find((item) => item.userId === task.userId);
  if (!account) {
    return;
  }
  const now = new Date().toISOString();
  account.balance += task.creditCost;
  account.totalEarned += task.creditCost;
  account.updatedAt = now;
  data.creditLedgerEntries.push({
    id: randomUUID(),
    userId: task.userId,
    type: "REFUND",
    amount: task.creditCost,
    balanceAfter: account.balance,
    sourceType: "TASK",
    sourceId: task.id,
    idempotencyKey,
    remark,
    createdAt: now
  });
}

async function createImage(task: GenerationTask, index: number, body: string, mimeType: string): Promise<GeneratedImage> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const extension = extensionForMimeType(mimeType);
  const imageKey = `generated/${task.userId}/${task.id}/${id}.${extension}`;
  const thumbnailKey = `generated/${task.userId}/${task.id}/${id}-thumb.${extension}`;
  const stored = await storage.putObject({
    key: imageKey,
    body,
    bodyEncoding: isBase64Mime(mimeType) ? "base64" : "utf8",
    mimeType
  });
  await storage.putObject({
    key: thumbnailKey,
    body: thumbnailBody(task, body, mimeType),
    bodyEncoding: isBase64Mime(mimeType) ? "base64" : "utf8",
    mimeType
  });
  return {
    id,
    taskId: task.id,
    userId: task.userId,
    storageKey: stored.key,
    thumbnailKey,
    publicUrl: stored.publicUrl,
    width: task.width,
    height: task.height,
    fileSize: stored.fileSize,
    mimeType,
    safetyStatus: "PASSED",
    visibility: "PRIVATE",
    deletedAt: null,
    createdAt: now
  };
}

function thumbnailBody(task: GenerationTask, body: string, mimeType: string): string {
  if (mimeType !== "image/svg+xml") {
    return body;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 ${task.width} ${task.height}">${body
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")}</svg>`;
}

function isBase64Mime(mimeType: string): boolean {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

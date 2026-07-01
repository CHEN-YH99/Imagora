import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createImageGenerationProvider, isProviderError, quoteImageGeneration } from "@imagora/ai-providers";
import { createStore } from "@imagora/database";
import { startGenerationWorker, type GenerationQueueJob } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import { createObjectStorage } from "@imagora/storage";
import { expireCredits, type GeneratedImage, type GenerationTask, type ModelId, type StoreData } from "@imagora/shared";

const isProduction = process.env.NODE_ENV === "production";

validateProductionConfig();

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
    expireCredits(data);
    const task = data.generationTasks.find((item) => item.status === "PENDING");
    if (!task) {
      return;
    }
    await processTask(data, task);
  });
}

async function processQueuedJob(job: GenerationQueueJob): Promise<void> {
  await store.update(async (data) => {
    refundStaleRunningTasks(data);
    const task = data.generationTasks.find((item) => item.id === job.taskId && item.status === "PENDING");
    if (!task) {
      return;
    }
    await processTask(data, task);
  });
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
      model: task.modelName as ModelId | undefined,
      referenceImageUrl: task.referenceImageId
        ? data.referenceImages.find((image) => image.id === task.referenceImageId && !image.deletedAt)?.publicUrl
        : null
    });
    console.log(`[imagora-worker] task ${task.id} provider request ${result.providerRequestId}`);

    const blockedImage = await firstBlockedGeneratedImage(result.images);
    if (blockedImage) {
      recordSafetyEvent(
        data,
        task,
        blockedImage.index,
        blockedImage.reasonCode,
        blockedImage.reasonMessage,
        blockedImage.provider
      );
      failTask(data, task, blockedImage.reasonCode, blockedImage.reasonMessage, "BLOCKED");
      return;
    }

    const createdImages = await createImages(task, result.images);
    data.generatedImages.push(...createdImages);
    // 按实际交付张数记录供应商真实成本（分），用于后台毛利核算
    const deliveredQuote = quoteImageGeneration({
      style: task.style,
      quality: task.quality,
      quantity: createdImages.length,
      aspectRatio: task.aspectRatio,
      model: task.modelName as ModelId | undefined
    });
    task.providerCostCents = deliveredQuote.providerCostCents;
  } catch (error) {
    if (isProviderError(error) && error.code === "PROVIDER_CONTENT_BLOCKED") {
      recordSafetyEvent(data, task, 0, error.code, error.message, error.provider);
      failTask(data, task, error.code, error.message, "BLOCKED");
      return;
    }
    const failure = mapProviderFailure(error);
    failTask(data, task, failure.code, failure.message);
    return;
  }

  task.status = "SUCCEEDED";
  task.completedAt = new Date().toISOString();
  task.updatedAt = task.completedAt;
  console.log(`[imagora-worker] task ${task.id} completed with ${task.quantity} image(s)`);
}

async function firstBlockedGeneratedImage(
  images: Array<{ index: number; bytes: string; mimeType: string }>
): Promise<{ index: number; reasonCode: string; reasonMessage: string; provider: string } | null> {
  for (const image of images) {
    const safetyResult = await safety.checkImage({ mimeType: image.mimeType, bytes: image.bytes });
    if (safetyResult.status === "BLOCKED") {
      return {
        index: image.index,
        reasonCode: safetyResult.reasonCode,
        reasonMessage: safetyResult.reasonMessage,
        provider: safetyResult.provider
      };
    }
  }
  return null;
}

async function createImages(
  task: GenerationTask,
  images: Array<{ index: number; bytes: string; mimeType: string }>
): Promise<GeneratedImage[]> {
  const createdImages: GeneratedImage[] = [];
  try {
    for (const image of images) {
      createdImages.push(await createImage(task, image.index, image.bytes, image.mimeType));
    }
    return createdImages;
  } catch (error) {
    await cleanupCreatedImages(createdImages);
    throw error;
  }
}

async function cleanupCreatedImages(images: GeneratedImage[]): Promise<void> {
  await Promise.allSettled(
    images.flatMap((image) => [storage.deleteObject(image.storageKey), storage.deleteObject(image.thumbnailKey)])
  );
}

function recordSafetyEvent(
  data: StoreData,
  task: GenerationTask,
  imageIndex: number,
  reasonCode: string,
  reasonMessage: string,
  providerName: string
): void {
  data.safetyEvents.push({
    id: randomUUID(),
    userId: task.userId,
    targetType: "GENERATED_IMAGE",
    targetId: `${task.id}:${imageIndex}`,
    status: "BLOCKED",
    reasonCode,
    reasonMessage,
    provider: providerName,
    createdAt: new Date().toISOString()
  });
}

function mapProviderFailure(error: unknown): { code: string; message: string } {
  if (isProviderError(error)) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "PROVIDER_FAILED",
    message: error instanceof Error ? error.message : "Provider failed"
  };
}

function failTask(
  data: StoreData,
  task: GenerationTask,
  code: string,
  message: string,
  status: GenerationTask["status"] = "FAILED"
): void {
  const now = new Date().toISOString();
  task.status = status;
  task.failureCode = code;
  task.failureMessage = message;
  task.completedAt = now;
  task.updatedAt = now;
  refundTask(data, task, "Task failed before image delivery");
  recordOperationalIncident(data, task, code, message, status === "BLOCKED" ? "warning" : "critical");
  console.log(`[imagora-worker] task ${task.id} ${status.toLowerCase()} and refunded`);
}

function recordOperationalIncident(
  data: StoreData,
  task: GenerationTask,
  errorCode: string,
  message: string,
  severity: "warning" | "critical"
): void {
  data.operationalIncidents ??= [];
  const now = new Date().toISOString();
  const existing = data.operationalIncidents.find(
    (incident) => incident.status === "OPEN" && incident.taskId === task.id && incident.errorCode === errorCode
  );
  if (existing) {
    existing.message = sanitizeOperationalMessage(message);
    existing.severity = severity;
    existing.updatedAt = now;
    return;
  }
  data.operationalIncidents.push({
    id: randomUUID(),
    severity,
    area: "generation",
    status: "OPEN",
    message: sanitizeOperationalMessage(message),
    errorCode,
    requestId: null,
    userId: task.userId,
    taskId: task.id,
    orderId: null,
    route: "worker:generation",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  });
  data.operationalIncidents = data.operationalIncidents
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, incidentRetentionMax());
}

function sanitizeOperationalMessage(message: string): string {
  return message
    .replace(/(password|passwd|token|captcha|secret|api[_-]?key|authorization)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .slice(0, 280);
}

function incidentRetentionMax(): number {
  const value = Number(process.env.INCIDENT_RETENTION_MAX ?? 100);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
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
    createdAt: now,
    expiresAt: null
  });
}

async function createImage(
  task: GenerationTask,
  index: number,
  body: string,
  mimeType: string
): Promise<GeneratedImage> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const extension = extensionForMimeType(mimeType);
  const imageKey = `generated/${task.userId}/${task.id}/${id}.${extension}`;
  const stored = await storage.putObject({
    key: imageKey,
    body,
    bodyEncoding: isBase64Mime(mimeType) ? "base64" : "utf8",
    mimeType
  });
  let thumbnailKey = "";
  let thumbnailUrl = "";
  try {
    const thumbnail = await thumbnailObject(task, body, mimeType);
    thumbnailKey = `generated/${task.userId}/${task.id}/${id}-thumb.${thumbnail.extension}`;
    const storedThumbnail = await storage.putObject({
      key: thumbnailKey,
      body: thumbnail.body,
      bodyEncoding: thumbnail.bodyEncoding,
      mimeType: thumbnail.mimeType
    });
    thumbnailUrl = storedThumbnail.publicUrl;
  } catch (error) {
    await cleanupStorageKeys([stored.key, thumbnailKey]);
    throw error;
  }
  return {
    id,
    taskId: task.id,
    userId: task.userId,
    storageKey: stored.key,
    thumbnailKey,
    thumbnailUrl,
    publicUrl: "",
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

async function cleanupStorageKeys(keys: string[]): Promise<void> {
  const targets = keys.filter(Boolean);
  await Promise.allSettled(targets.map((key) => storage.deleteObject(key)));
}

interface ThumbnailObject {
  body: string;
  bodyEncoding: "utf8" | "base64";
  mimeType: string;
  extension: string;
}

async function thumbnailObject(task: GenerationTask, body: string, mimeType: string): Promise<ThumbnailObject> {
  if (mimeType === "image/svg+xml") {
    return {
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 ${task.width} ${task.height}">${body
        .replace(/^<svg[^>]*>/, "")
        .replace(/<\/svg>$/, "")}</svg>`,
      bodyEncoding: "utf8",
      mimeType,
      extension: "svg"
    };
  }

  if (isBase64Mime(mimeType)) {
    try {
      const buffer = Buffer.from(body, "base64");
      const thumbnailBuffer = await sharp(buffer)
        .resize(320, 320, {
          fit: "inside",
          withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      return {
        body: thumbnailBuffer.toString("base64"),
        bodyEncoding: "base64",
        mimeType: "image/jpeg",
        extension: "jpg"
      };
    } catch (error) {
      console.error("Failed to generate thumbnail, using original image:", error);
    }
  }

  return {
    body,
    bodyEncoding: isBase64Mime(mimeType) ? "base64" : "utf8",
    mimeType,
    extension: extensionForMimeType(mimeType)
  };
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

function validateProductionConfig(): void {
  if (!isProduction) {
    return;
  }

  requireProductionValue("DATABASE_URL");
  requireProductionValue("REDIS_URL");
  requireProductionValue("OPENAI_API_KEY");
  requireProductionValue("S3_ENDPOINT");
  requireProductionValue("S3_BUCKET");
  requireProductionValue("S3_ACCESS_KEY_ID");
  requireProductionValue("S3_SECRET_ACCESS_KEY");
  requireProductionValue("S3_PUBLIC_BASE_URL");
  requireProductionSetting("DATA_STORE", "prisma");
  requireProductionSetting("QUEUE_PROVIDER", "bullmq");
  requireProductionSetting("AI_PROVIDER", "openai");
  requireProductionSetting("STORAGE_PROVIDER", "s3", "r2");
}

function requireProductionValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Unsafe production config: ${name} is required`);
  }
  return value;
}

function requireProductionSetting(name: string, ...allowedValues: string[]): void {
  const value = requireProductionValue(name);
  if (!allowedValues.includes(value)) {
    throw new Error(`Unsafe production config: ${name} must be ${allowedValues.join(" or ")}`);
  }
}

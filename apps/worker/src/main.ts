import { randomUUID } from "node:crypto";
import pino from "pino";
import sharp from "sharp";
import {
  createImageGenerationProvider,
  isProviderError,
  quoteImageGeneration,
  resolveDefaultImageModel,
  resolveDefaultImageProvider
} from "@imagora/ai-providers";
import { createStore } from "@imagora/database";
import { startGenerationWorker, type GenerationQueueJob } from "@imagora/queue";
import { createSafetyProvider } from "@imagora/safety";
import { createObjectStorage } from "@imagora/storage";
import {
  expireCredits,
  refundTaskCredits,
  runGenerationMaintenance,
  type GeneratedImage,
  type GenerationTask,
  type StoreData
} from "@imagora/shared";

const isProduction = process.env.NODE_ENV === "production";

// 与 API 对齐的结构化日志：生产输出 JSON，开发用 pino-pretty
const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  base: { service: "imagora-worker" },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }
        }
      })
});

validateProductionConfig();

const store = createStore();
const provider = createImageGenerationProvider();
const storage = createObjectStorage();
const safety = createSafetyProvider();
const queueProvider = process.env.QUEUE_PROVIDER ?? "inline";
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2500);
let inlineTickPromise: Promise<void> | null = null;

interface ClaimedTask {
  task: GenerationTask;
  referenceImageUrl: string | null;
}

type TaskExecutionResult =
  | {
      kind: "succeeded";
      createdImages: GeneratedImage[];
      providerCostCents: number;
      creditDifference: number;
    }
  | {
      kind: "blocked";
      imageIndex: number;
      status: "BLOCKED" | "REVIEW_REQUIRED";
      reasonCode: string;
      reasonMessage: string;
      providerName: string;
    }
  | {
      kind: "failed";
      code: string;
      message: string;
    };

logger.info({ queueProvider, provider: provider.name, modelName: provider.modelName }, "worker started");

if (queueProvider === "bullmq") {
  startGenerationWorker(processQueuedJob);
} else {
  logger.info({ pollIntervalMs }, "worker polling enabled");
  await runInlineTick();
  setInterval(() => {
    runInlineTick().catch((error) => {
      logger.error({ err: error }, "worker tick failed");
    });
  }, pollIntervalMs);
}

function runInlineTick(): Promise<void> {
  if (inlineTickPromise) {
    return inlineTickPromise;
  }
  inlineTickPromise = tick().finally(() => {
    inlineTickPromise = null;
  });
  return inlineTickPromise;
}

async function tick(): Promise<void> {
  const claimedTask = await claimNextPendingTask();
  if (!claimedTask) {
    return;
  }
  await processClaimedTask(claimedTask);
}

async function processQueuedJob(job: GenerationQueueJob): Promise<void> {
  const claimedTask = await claimTaskById(job.taskId);
  if (!claimedTask) {
    return;
  }
  await processClaimedTask(claimedTask);
}

async function claimNextPendingTask(): Promise<ClaimedTask | null> {
  return claimTask((data) => data.generationTasks.find((item) => item.status === "PENDING"));
}

async function claimTaskById(taskId: string): Promise<ClaimedTask | null> {
  return claimTask((data) => data.generationTasks.find((item) => item.id === taskId && item.status === "PENDING"));
}

async function claimTask(selectTask: (data: StoreData) => GenerationTask | undefined): Promise<ClaimedTask | null> {
  return store.update((data) => {
    runWorkerMaintenance(data);
    const task = selectTask(data);
    if (!task) {
      return null;
    }
    const now = new Date().toISOString();
    task.status = "RUNNING";
    task.startedAt = now;
    task.completedAt = null;
    task.failureCode = null;
    task.failureMessage = null;
    task.updatedAt = now;
    return {
      task: { ...task },
      referenceImageUrl: task.referenceImageId
        ? (data.referenceImages.find((image) => image.id === task.referenceImageId && !image.deletedAt)?.publicUrl ??
          null)
        : null
    };
  });
}

async function processClaimedTask(claimedTask: ClaimedTask): Promise<void> {
  const outcome = await executeTask(claimedTask);
  await persistTaskOutcome(claimedTask.task, outcome);
}

async function executeTask({ task, referenceImageUrl }: ClaimedTask): Promise<TaskExecutionResult> {
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
      model: task.modelName || undefined,
      referenceImageUrl
    });
    logger.info({ taskId: task.id, providerRequestId: result.providerRequestId }, "provider request completed");

    const blockedOrReviewImage = await firstBlockedOrReviewImage(result.images);
    if (blockedOrReviewImage) {
      return {
        kind: "blocked",
        imageIndex: blockedOrReviewImage.index,
        status: blockedOrReviewImage.status,
        reasonCode: blockedOrReviewImage.reasonCode,
        reasonMessage: blockedOrReviewImage.reasonMessage,
        providerName: blockedOrReviewImage.provider
      };
    }

    const createdImages = await createImages(task, result.images);
    if (createdImages.length === 0) {
      return {
        kind: "failed",
        code: "NO_IMAGES_DELIVERED",
        message: "模型服务未返回可用图片，本次扣除的积分已自动返还。"
      };
    }
    const deliveredQuote = quoteImageGeneration({
      style: task.style,
      quality: task.quality,
      quantity: createdImages.length,
      aspectRatio: task.aspectRatio,
      model: task.modelName || undefined
    });
    return {
      kind: "succeeded",
      createdImages,
      providerCostCents: deliveredQuote.providerCostCents,
      creditDifference: task.creditCost - deliveredQuote.creditCost
    };
  } catch (error) {
    if (isProviderError(error) && error.code === "PROVIDER_CONTENT_BLOCKED") {
      return {
        kind: "blocked",
        imageIndex: 0,
        status: "BLOCKED",
        reasonCode: error.code,
        reasonMessage: error.message,
        providerName: error.provider
      };
    }
    const failure = mapProviderFailure(error);
    return {
      kind: "failed",
      code: failure.code,
      message: failure.message
    };
  }
}

async function persistTaskOutcome(taskSnapshot: GenerationTask, outcome: TaskExecutionResult): Promise<void> {
  const createdImages = outcome.kind === "succeeded" ? outcome.createdImages : [];
  let persistResult: { finalized: boolean; status: GenerationTask["status"] | null } = {
    finalized: false,
    status: null
  };

  try {
    persistResult = await store.update((data) => {
      const task = data.generationTasks.find((item) => item.id === taskSnapshot.id);
      if (!task || task.status !== "RUNNING") {
        return { finalized: false as const, status: task?.status ?? null };
      }

      if (outcome.kind === "succeeded") {
        data.generatedImages.push(...outcome.createdImages);
        task.providerCostCents = outcome.providerCostCents;
        if (outcome.createdImages.length < task.quantity && outcome.creditDifference > 0) {
          refundTaskCredits(data, task, outcome.creditDifference, "未交付图片的积分自动返还");
        }
        task.status = "SUCCEEDED";
        task.completedAt = new Date().toISOString();
        task.updatedAt = task.completedAt;
        return { finalized: true as const, status: task.status };
      }

      if (outcome.kind === "blocked") {
        recordSafetyEvent(
          data,
          task,
          outcome.imageIndex,
          outcome.status,
          outcome.reasonCode,
          outcome.reasonMessage,
          outcome.providerName
        );
        failTask(data, task, outcome.reasonCode, outcome.reasonMessage, "BLOCKED");
        return { finalized: true as const, status: task.status };
      }

      failTask(data, task, outcome.code, outcome.message);
      return { finalized: true as const, status: task.status };
    });
  } catch (error) {
    if (createdImages.length > 0) {
      await cleanupCreatedImages(createdImages);
    }
    throw error;
  }

  if (!persistResult.finalized) {
    if (createdImages.length > 0) {
      await cleanupCreatedImages(createdImages);
    }
    logger.warn(
      { taskId: taskSnapshot.id, status: persistResult.status },
      "task finalize skipped because task state changed"
    );
    return;
  }

  if (outcome.kind === "succeeded") {
    logger.info({ taskId: taskSnapshot.id, quantity: outcome.createdImages.length }, "task completed");
  }
}

async function firstBlockedOrReviewImage(images: Array<{ index: number; bytes: string; mimeType: string }>): Promise<{
  index: number;
  status: "BLOCKED" | "REVIEW_REQUIRED";
  reasonCode: string;
  reasonMessage: string;
  provider: string;
} | null> {
  for (const image of images) {
    const safetyResult = await safety.checkImage({ mimeType: image.mimeType, bytes: image.bytes });
    if (safetyResult.status === "BLOCKED" || safetyResult.status === "REVIEW_REQUIRED") {
      return {
        index: image.index,
        status: safetyResult.status,
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
  status: "BLOCKED" | "REVIEW_REQUIRED",
  reasonCode: string,
  reasonMessage: string,
  providerName: string
): void {
  data.safetyEvents.push({
    id: randomUUID(),
    userId: task.userId,
    targetType: "GENERATED_IMAGE",
    targetId: `${task.id}:${imageIndex}`,
    status,
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
  refundTaskCredits(data, task, task.creditCost, "Task failed before image delivery");
  recordOperationalIncident(data, task, code, message, status === "BLOCKED" ? "warning" : "critical");
  logger.warn({ taskId: task.id, status, code }, "task failed and refunded");
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

function runWorkerMaintenance(data: StoreData): void {
  runGenerationMaintenance(data, generationMaintenanceOptions());
  expireCredits(data);
}

function generationMaintenanceOptions() {
  return {
    pendingTimeoutMs: envNumber("GENERATION_PENDING_TIMEOUT_MS", 5 * 60 * 1000),
    runningTimeoutMs: envNumber("GENERATION_RUNNING_TIMEOUT_MS", 15 * 60 * 1000)
  };
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
      logger.error({ err: error, taskId: task.id }, "thumbnail generation failed, using original image");
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
  requireProductionValue("SAFETY_TEXT_ENDPOINT");
  requireProductionValue("SAFETY_IMAGE_ENDPOINT");
  requireProductionSetting("DATA_STORE", "prisma");
  requireProductionSetting("QUEUE_PROVIDER", "bullmq");
  requireProductionImageProvider("openai");
  requireProductionImageModel();
  requireProductionSetting("STORAGE_PROVIDER", "s3", "r2");
  requireProductionSetting("SAFETY_PROVIDER", "http");
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

function requireProductionImageProvider(...allowedValues: string[]): void {
  let value: string;
  try {
    value = resolveDefaultImageProvider();
  } catch (error) {
    throw new Error(
      `Unsafe production config: ${error instanceof Error ? error.message : "image provider is not configured"}`
    );
  }
  if (!allowedValues.includes(value)) {
    throw new Error(
      `Unsafe production config: IMAGE_PROVIDER_DEFAULT (or legacy AI_PROVIDER) must be ${allowedValues.join(" or ")}`
    );
  }
}

function requireProductionImageModel(): void {
  try {
    resolveDefaultImageModel(resolveDefaultImageProvider());
  } catch (error) {
    throw new Error(
      `Unsafe production config: ${error instanceof Error ? error.message : "image model is not configured"}`
    );
  }
}

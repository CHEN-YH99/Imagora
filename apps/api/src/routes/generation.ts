import { createImageGenerationSnapshot, quoteImageGeneration } from "@imagora/ai-providers";
import { imageModelDiscovery } from "../image-model-discovery.js";
import { z } from "zod";
import { Readable } from "node:stream";
import { sessionToken } from "../auth-runtime.js";
import { createGenerationEventsRuntime } from "../generation-events-runtime.js";
import { createGenerationProgress, type GenerationTask, type ReferenceImage } from "@imagora/shared";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerGenerationRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  const generationEvents = createGenerationEventsRuntime(context.store);
  app.addHook("preClose", async () => generationEvents.close());
  const {
    AppError,
    addDays,
    assertEmailVerified,
    assertFeatureEnabled,
    descCreated,
    enqueueGenerationTask,
    envelope,
    envNumber,
    extensionForMime,
    generationInputSchema,
    idParamSchema,
    inspectReferenceUpload,
    mustFindCreditAccount,
    mustFindOwnReferenceImage,
    mustFindOwnTask,
    quote,
    randomUUID,
    referenceUploadSchema,
    requireAuth,
    resolveGenerationProviderSelection,
    safetyProvider,
    spendCredits,
    storage,
    store,
    taskQuerySchema,
    taskWithRefund,
    uploadBodyLimitBytes,
    withoutImagePublicUrl
  } = context;

  function resolveRequestedGeneration(input: z.infer<typeof generationInputSchema>) {
    try {
      if (input.channel) {
        const modelSnapshot = imageModelDiscovery.snapshot(input.channel, input.model);
        return {
          modelSnapshot,
          estimated: quoteImageGeneration({ ...input, model: modelSnapshot.model.modelId, modelSnapshot })
        };
      }
      const { model } = resolveGenerationProviderSelection(input.model);
      quote({ ...input, model });
      const modelSnapshot = createImageGenerationSnapshot(model);
      return { modelSnapshot, estimated: quoteImageGeneration({ ...input, model, modelSnapshot }) };
    } catch (error) {
      throw new AppError("VALIDATION_ERROR", error instanceof Error ? error.message : "模型或线路不可用。", 400);
    }
  }

  app.get("/api/generation/models", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { channel } = z.object({ channel: z.string().trim().min(1).max(64).optional() }).parse(request.query);
    try {
      return envelope(request, imageModelDiscovery.catalog(channel));
    } catch (error) {
      throw new AppError("VALIDATION_ERROR", error instanceof Error ? error.message : "线路不可用。", 400);
    }
  });

  app.post("/api/generation/quote", async (request) => {
    assertFeatureEnabled("generation");
    await requireAuth(request);
    const input = generationInputSchema.parse(request.body);
    const estimatedCost = input.channel ? resolveRequestedGeneration(input).estimated.creditCost : quote(input);
    return envelope(request, { creditCost: estimatedCost, balanceRequired: estimatedCost });
  });

  app.post("/api/generation/tasks", async (request, reply) => {
    assertFeatureEnabled("generation");
    const { user } = await requireAuth(request);
    assertEmailVerified(user);
    const input = generationInputSchema.parse(request.body);
    const { modelSnapshot, estimated } = resolveRequestedGeneration(input);
    const resolvedModel = modelSnapshot.model.modelId;
    const resolvedProviderMetadata = { name: modelSnapshot.model.provider };
    const cost = estimated.creditCost;
    const result = await store.update(async (data) => {
      const duplicate = data.generationTasks.find(
        (task) => task.userId === user.id && task.clientRequestId === input.clientRequestId
      );
      if (duplicate) {
        return {
          blocked: false as const,
          task: taskWithRefund(data, duplicate),
          balanceAfter: mustFindCreditAccount(data, user.id).balance,
          enqueue: duplicate.status === "PENDING",
          created: false,
          requestedAt: duplicate.createdAt
        };
      }
      const referenceImage = input.referenceImageId
        ? mustFindOwnReferenceImage(data, user.id, input.referenceImageId)
        : null;
      const safety = await safetyProvider.checkText({
        text: [input.prompt, input.negativePrompt ?? ""].join("\n"),
        blockedTerms: data.safetyRules
          .filter((rule) => rule.status === "ACTIVE" && rule.action === "BLOCK")
          .map((rule) => rule.term),
        reviewTerms: data.safetyRules
          .filter((rule) => rule.status === "ACTIVE" && rule.action === "REVIEW")
          .map((rule) => rule.term)
      });
      if (safety.status === "BLOCKED" || safety.status === "REVIEW_REQUIRED") {
        // 注意：store.update 在回调抛异常时会回滚，不落库。安全事件必须靠“正常返回”提交，
        // 再在事务外抛 AppError，否则待复核/拦截记录会随回滚丢失，人工复核队列永远为空。
        data.safetyEvents.push({
          id: randomUUID(),
          userId: user.id,
          targetType: "PROMPT",
          targetId: input.clientRequestId,
          status: safety.status,
          reasonCode: safety.reasonCode,
          reasonMessage: safety.reasonMessage,
          provider: safety.provider,
          createdAt: new Date().toISOString()
        });
        return { blocked: true as const, safety };
      }
      const account = mustFindCreditAccount(data, user.id);
      if (account.balance < cost) {
        throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402, {
          balance: account.balance,
          required: cost
        });
      }
      const now = new Date().toISOString();
      const dimension = estimated;
      const task: GenerationTask = {
        id: randomUUID(),
        userId: user.id,
        clientRequestId: input.clientRequestId,
        referenceImageId: referenceImage?.id ?? null,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt ?? null,
        style: input.style,
        aspectRatio: input.aspectRatio,
        width: dimension.width,
        height: dimension.height,
        quantity: input.quantity,
        quality: input.quality,
        modelProvider: resolvedProviderMetadata.name,
        modelName: resolvedModel,
        modelSnapshot,
        status: "PENDING",
        progress: createGenerationProgress("QUEUED", now),
        creditCost: cost,
        providerCostCents: 0,
        failureCode: null,
        failureMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      };
      data.generationTasks.push(task);
      spendCredits(data, user.id, cost, "TASK", task.id, `task-spend:${task.id}`, "Image generation task");
      return {
        blocked: false as const,
        task: taskWithRefund(data, task),
        balanceAfter: mustFindCreditAccount(data, user.id).balance,
        enqueue: true,
        created: true,
        requestedAt: now
      };
    });
    if (result.blocked) {
      // 安全事件已在上面的事务里落库，这里才安全地抛错拦截请求。
      // REVIEW_REQUIRED 用独立错误码，前端才能给出“人工复核 + 申诉”文案，而不是笼统的拦截提示。
      const review = result.safety.status === "REVIEW_REQUIRED";
      throw new AppError(
        review ? "CONTENT_REVIEW_REQUIRED" : "CONTENT_BLOCKED",
        review ? "Prompt requires manual safety review" : "Prompt was blocked by safety rules",
        400,
        { ...result.safety }
      );
    }
    if (result.enqueue) {
      await enqueueGenerationTask(result.task.id, user.id, result.requestedAt);
    }
    if (result.created) {
      reply.status(201);
    }
    return envelope(request, { task: result.task, balanceAfter: result.balanceAfter });
  });

  app.post("/api/uploads/reference-images", { bodyLimit: uploadBodyLimitBytes() }, async (request, reply) => {
    assertFeatureEnabled("uploads");
    const { user } = await requireAuth(request);
    const input = referenceUploadSchema.parse(request.body);
    const upload = inspectReferenceUpload(input);
    const safety = await safetyProvider.checkImage({ mimeType: upload.mimeType, bytes: upload.contentBase64 });

    const result = await store.update(async (data) => {
      if (safety.status === "BLOCKED" || safety.status === "REVIEW_REQUIRED") {
        // 同 /api/generation/tasks：安全事件必须靠正常返回提交，抛异常会回滚导致记录丢失
        data.safetyEvents.push({
          id: randomUUID(),
          userId: user.id,
          targetType: "UPLOAD_IMAGE",
          targetId: upload.contentHash,
          status: safety.status,
          reasonCode: safety.reasonCode,
          reasonMessage: safety.reasonMessage,
          provider: safety.provider,
          createdAt: new Date().toISOString()
        });
        return { blocked: true as const, safety };
      }

      const existing = data.referenceImages.find(
        (image) => image.userId === user.id && image.contentHash === upload.contentHash && !image.deletedAt
      );
      if (existing) {
        return { blocked: false as const, referenceImage: existing, duplicate: true, created: false };
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const stored = await storage.putObject({
        key: `reference/${user.id}/${id}.${extensionForMime(upload.mimeType)}`,
        body: upload.contentBase64,
        bodyEncoding: "base64",
        mimeType: upload.mimeType
      });
      const referenceImage: ReferenceImage = {
        id,
        userId: user.id,
        storageKey: stored.key,
        publicUrl: stored.publicUrl,
        originalFileName: input.fileName,
        mimeType: upload.mimeType,
        fileSize: upload.fileSize,
        width: upload.width,
        height: upload.height,
        contentHash: upload.contentHash,
        safetyStatus: "PASSED",
        createdAt: now,
        expiresAt: addDays(now, envNumber("UPLOAD_REFERENCE_TTL_DAYS", 1)),
        deletedAt: null
      };
      data.referenceImages.push(referenceImage);
      return { blocked: false as const, referenceImage, duplicate: false, created: true };
    });
    if (result.blocked) {
      // 安全事件已在事务里落库,这里才抛错拦截。参考图 REVIEW 同样拦截,因为花钱的是后续生成而非上传本身。
      const review = result.safety.status === "REVIEW_REQUIRED";
      throw new AppError(
        review ? "CONTENT_REVIEW_REQUIRED" : "CONTENT_BLOCKED",
        review ? "Reference image requires manual safety review" : "Reference image was blocked by safety rules",
        400,
        { ...result.safety }
      );
    }
    if (result.created) {
      reply.status(201);
    }
    return envelope(request, { referenceImage: result.referenceImage, duplicate: result.duplicate });
  });

  app.get("/api/generation/tasks", async (request) => {
    const { user, data } = await requireAuth(request);
    const query = taskQuerySchema.parse(request.query);
    const matchingTasks = data.generationTasks
      .filter((task) => task.userId === user.id)
      .filter((task) => (query.status ? task.status === query.status : true))
      .sort(descCreated);
    const total = matchingTasks.length;
    const tasks = matchingTasks
      .slice(query.offset, query.offset + query.limit)
      .map((task) => taskWithRefund(data, task));
    return envelope(request, {
      tasks,
      pageInfo: {
        offset: query.offset,
        limit: query.limit,
        total,
        hasMore: query.offset + tasks.length < total
      }
    });
  });

  app.get("/api/generation/tasks/:taskId", async (request) => {
    const { user, data } = await requireAuth(request);
    const { taskId } = idParamSchema.parse(request.params);
    const task = mustFindOwnTask(data, user.id, taskId);
    const images = data.generatedImages
      .filter((image) => image.taskId === task.id && !image.deletedAt)
      .map(withoutImagePublicUrl);
    return envelope(request, { task: taskWithRefund(data, task), images });
  });

  app.get("/api/generation/tasks/:taskId/events", async (request, reply) => {
    const { taskId } = idParamSchema.parse(request.params);
    const subscription = generationEvents.subscribe(sessionToken(request), taskId);
    const close = () => subscription.close();
    request.raw.socket.setTimeout(0);
    reply.raw.once("close", close);
    try {
      // 首个定向快照同时校验会话及任务归属；鉴权失败仍返回正常 HTTP 错误。
      await subscription.ready;
    } catch (error) {
      close();
      reply.raw.off("close", close);
      throw error;
    }
    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    reply.header("Cache-Control", "no-cache, no-transform");
    reply.header("X-Accel-Buffering", "no");
    const stream = Readable.from(
      (async function* () {
        try {
          for await (const update of subscription.events) {
            if (update === null) {
              yield "event: heartbeat\ndata: {}\n\n";
              continue;
            }
            const { task } = update;
            const version = [task.updatedAt, task.progress?.sequence ?? 0, task.status].join(":");
            const images = update.images.map(withoutImagePublicUrl);
            yield `id: ${version}\ndata: ${JSON.stringify({ task: taskWithRefund(update, task), images })}\n\n`;
          }
        } catch (error) {
          if (!reply.raw.destroyed) {
            request.log.warn({ err: error, taskId }, "generation event stream closed");
            yield "event: unavailable\ndata: {}\n\n";
          }
        } finally {
          close();
          reply.raw.off("close", close);
        }
      })()
    );
    return reply.send(stream);
  });

  app.post("/api/generation/tasks/:taskId/retry", async (request, reply) => {
    const { user } = await requireAuth(request);
    const { taskId } = idParamSchema.parse(request.params);
    const result = await store.update(async (data) => {
      const previous = mustFindOwnTask(data, user.id, taskId);
      if (!["FAILED", "BLOCKED"].includes(previous.status)) {
        throw new AppError("TASK_NOT_RETRYABLE", "Only failed or blocked tasks can be retried", 400);
      }
      const now = new Date().toISOString();
      const task: GenerationTask = {
        ...previous,
        id: randomUUID(),
        clientRequestId: `retry:${previous.id}:${now}`,
        status: "PENDING",
        progress: createGenerationProgress("QUEUED", now),
        providerCostCents: 0,
        failureCode: null,
        failureMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      };
      const account = mustFindCreditAccount(data, user.id);
      if (account.balance < task.creditCost) {
        throw new AppError("INSUFFICIENT_CREDITS", "Credit balance is not enough", 402);
      }
      data.generationTasks.push(task);
      spendCredits(
        data,
        user.id,
        task.creditCost,
        "TASK",
        task.id,
        `task-spend:${task.id}`,
        "Retry image generation task"
      );
      return { task: taskWithRefund(data, task), balanceAfter: mustFindCreditAccount(data, user.id).balance };
    });
    await enqueueGenerationTask(result.task.id, user.id, result.task.createdAt);
    reply.status(201);
    return envelope(request, { task: result.task, balanceAfter: result.balanceAfter });
  });
}

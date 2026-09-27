import {
  aspectRatioDimensions,
  type AspectRatio,
  type ModelId,
  type Quality,
  type StyleId,
  type ImageGenerationSnapshot,
  type ImageSize
} from "@imagora/shared";
import {
  createChannelHealthStore,
  createResilientChannelHealthStore,
  type ChannelHealthStore
} from "./channel-health.js";
import { hasConfiguredImageChannel, resolveImageChannels, type ImageChannelConfig } from "./channels.js";
import {
  publicImageModel,
  hasDiscoveredImageModels,
  readImageModelConfigs,
  resolveModelChannels,
  type ProviderModelConfig,
  type PublicImageModel
} from "./models.js";

export {
  readImageModelConfigs,
  resolveModelChannels,
  type ProviderModelConfig,
  type PublicImageModel
} from "./models.js";

export {
  createChannelHealthStore,
  createResilientChannelHealthStore,
  DEFAULT_CHANNEL_COOLDOWN_MS,
  DEFAULT_CHANNEL_FAILURE_THRESHOLD,
  DEFAULT_CHANNEL_FAILURE_WINDOW_MS,
  readChannelHealthSettings,
  resolveChannelHealthProvider,
  type ChannelHealthProvider,
  type ChannelHealthSettings,
  type ChannelHealthState,
  type ChannelHealthStore,
  type ChannelHealthStoreOptions
} from "./channel-health.js";
export {
  hasConfiguredImageChannel,
  parseImageChannels,
  resolveAllImageChannels,
  resolveImageChannels,
  type ImageChannelConfig
} from "./channels.js";

export {
  ImageModelDiscovery,
  parseImageModelDirectory,
  buildDiscoveredImageModels,
  type ImageModelDiscoveryStatus
} from "./model-discovery.js";
export { publishImageModelConfigs } from "./models.js";

export const DEFAULT_OPENAI_MODEL = "gpt-image-2" as const;
export const MOCK_MODEL = "mock" as const;
export const DEFAULT_OPENAI_MODEL_ID = "openai:gpt-image-2" as const;
export const MOCK_MODEL_ID = "mock:default" as const;
export const SUPPORTED_IMAGE_MODELS = [DEFAULT_OPENAI_MODEL_ID, MOCK_MODEL_ID] as const;
export const DEFAULT_OPENAI_TIMEOUT_MS = 300_000 as const;
export const DEFAULT_OPENAI_MAX_RETRIES = 1 as const;
export const MIN_PRODUCTION_OPENAI_TIMEOUT_MS = 300_000 as const;
export const MAX_PRODUCTION_OPENAI_MAX_RETRIES = 1 as const;
const DEFAULT_OPENAI_REMOTE_IMAGE_TIMEOUT_MS = 60_000;
const MAX_OPENAI_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

type SupportedImageModel = ModelId;
type SupportedProviderName = "mock" | "openai";
type OpenAiImageSize = `${number}x${number}`;
type OpenAiImageQuality = "low" | "medium" | "high";

export interface GenerateImageInput {
  taskId: string;
  prompt: string;
  negativePrompt?: string | null;
  style: StyleId;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  quantity: number;
  quality: Quality;
  model?: ModelId;
  modelSnapshot?: ImageGenerationSnapshot;
  referenceImageUrl?: string | null;
  /** 进度回调仅作通知：按顺序调用，但不等待异步完成；回调自行记录持久化错误。 */
  onStage?: (event: { stage: "GENERATING" | "RECEIVING"; imageIndex: number }) => void | Promise<void>;
  /** 仅在收到完整图片数据后上报，重试和等待不增加完成数；同样不等待回调完成。 */
  onProgress?: (progress: { completedImages: number; totalImages: number }) => void | Promise<void>;
}

export interface ProviderImage {
  bytes: string;
  mimeType: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  index: number;
}

export interface GenerateImageResult {
  providerRequestId: string;
  images: ProviderImage[];
  /**
   * 本次实际发生的供应商成本（分）。多渠道下各站定价不同，由 provider 按命中渠道汇总；
   * 未提供时调用方回落到模型配置的估算值。
   */
  providerCostCents?: number;
  /** 本次每张图实际命中的渠道名，按图片顺序 */
  channels?: string[];
  raw?: unknown;
}

export interface OpenAiImageGenerationProviderOptions {
  channels?: ImageChannelConfig[];
  healthStore?: ChannelHealthStore;
  /**
   * 超时是否参与渠道切换。默认 false：超时后上游可能仍在出图，
   * 换渠道重发会双份计费、双份出图。
   */
  failoverOnTimeout?: boolean;
  onChannelEvent?: (event: ImageChannelEvent) => void;
}

export type ImageChannelEvent =
  | {
      type: "channel_succeeded";
      channel: string;
      taskId: string;
      imageIndex: number;
    }
  | {
      type: "channel_failed";
      channel: string;
      taskId: string;
      imageIndex: number;
      code: ProviderErrorCode;
      statusCode?: number;
      message: string;
      tripped: boolean;
      willFailover: boolean;
    }
  | {
      type: "health_store_degraded";
      operation: string;
      message: string;
    };

export interface ImageChannelHealthReport {
  provider: "memory" | "redis";
  channels: Array<{
    name: string;
    baseUrl: string;
    priority: number;
    tripped: boolean;
    failures: number;
  }>;
}

interface ChannelAttemptOutcome {
  channel: ImageChannelConfig;
  image: { bytes: string; mimeType: ProviderImage["mimeType"] };
  requestId?: string;
}

interface OpenAiGenerationRequestBody {
  model: string;
  prompt: string;
  size?: OpenAiImageSize;
  aspect_ratio?: AspectRatio;
  quality?: OpenAiImageQuality;
  n: number;
  response_format: "b64_json";
  output_format?: "png";
}

export interface ImageGenerationProvider {
  name: SupportedProviderName;
  modelName: SupportedImageModel | string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

export type ProviderErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_CONTENT_BLOCKED"
  | "PROVIDER_EMPTY_RESULT"
  | "PROVIDER_BAD_RESPONSE"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_FAILED";

export class ProviderError extends Error {
  readonly name = "ProviderError";

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly options: {
      retryable: boolean;
      provider: SupportedProviderName;
      statusCode?: number;
      details?: unknown;
    }
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.options.retryable;
  }

  get provider(): SupportedProviderName {
    return this.options.provider;
  }

  get statusCode(): number | undefined {
    return this.options.statusCode;
  }

  get details(): unknown {
    return this.options.details;
  }
}

export interface ProviderMetadata {
  name: SupportedProviderName;
  modelName: SupportedImageModel | string;
}

/**
 * 该错误是否应该切换到下一个渠道重发。
 *
 * PROVIDER_TIMEOUT 刻意不在其中：请求已发出但等不到响应时，上游任务可能仍在执行，
 * 换渠道重发等于重复付费且两边都可能出图。超时仍会计入熔断（见 isChannelHealthSignal），
 * 后续任务自动绕开摆烂渠道，但当前这张图直接失败退积分。
 *
 * PROVIDER_CONTENT_BLOCKED 同样不切：内容审查在任何渠道都会拦，重发纯属浪费。
 */
export function shouldFailoverToNextChannel(error: ProviderError): boolean {
  switch (error.code) {
    case "PROVIDER_AUTH_FAILED":
    case "PROVIDER_RATE_LIMITED":
    case "PROVIDER_BAD_RESPONSE":
    case "PROVIDER_EMPTY_RESULT":
      return true;
    case "PROVIDER_FAILED":
      // 5xx 与「请求未送达」（连接失败/DNS/TLS）都归到这里，上游没有产生计费副作用。
      return true;
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_CONTENT_BLOCKED":
      return false;
  }
}

/**
 * 该错误是否说明「渠道本身有问题」，需要计入熔断计数。
 * 超时不切换但要计数：摆烂的站只会让第一个用户倒霉，后续请求自动绕开。
 * 内容审查是用户提示词的问题，不能算渠道的账。
 */
export function isChannelHealthSignal(error: ProviderError): boolean {
  return error.code !== "PROVIDER_CONTENT_BLOCKED";
}

export interface QuoteImageGenerationInput {
  style: StyleId;
  quality: Quality;
  quantity: number;
  aspectRatio: AspectRatio;
  model?: ModelId;
  modelSnapshot?: ImageGenerationSnapshot;
  provider?: string;
}

export interface ImageGenerationQuote {
  provider: SupportedProviderName;
  model: SupportedImageModel;
  creditCost: number;
  providerCostCents: number;
  width: number;
  height: number;
  size: OpenAiImageSize;
  quality: OpenAiImageQuality;
}

export interface OpenAiGenerationRuntimeConfig {
  timeoutMs: number;
  maxRetries: number;
  initialBackoffMs: number;
}

interface OpenAiImageResponse {
  id?: string;
  data?: unknown;
  images?: unknown;
  output?: unknown;
  result?: unknown;
  b64_json?: unknown;
  image_base64?: unknown;
  image?: unknown;
  error?: {
    message?: string;
    code?: string;
    type?: string;
    param?: string | null;
  };
}

interface OpenAiImageItem {
  b64_json?: string;
  url?: string;
  mimeType?: ProviderImage["mimeType"];
}

type NormalizedOpenAiImageResponse = OpenAiImageResponse & {
  data: OpenAiImageItem[];
};

interface OpenAiRemoteImageFetchOptions {
  timeoutMs: number;
  allowInsecureLocalhost: boolean;
}

const modelAliases: Record<string, SupportedImageModel> = {
  [DEFAULT_OPENAI_MODEL]: DEFAULT_OPENAI_MODEL_ID,
  [DEFAULT_OPENAI_MODEL_ID]: DEFAULT_OPENAI_MODEL_ID,
  [MOCK_MODEL]: MOCK_MODEL_ID,
  [MOCK_MODEL_ID]: MOCK_MODEL_ID
};

export class MockImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "mock";
  readonly modelName = MOCK_MODEL_ID;

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (/\bfail\b/i.test(input.prompt)) {
      throw new ProviderError("PROVIDER_FAILED", "生成服务返回失败，请调整提示词后重试。", {
        retryable: false,
        provider: this.name
      });
    }

    if (/\bempty\b/i.test(input.prompt)) {
      throw new ProviderError("PROVIDER_EMPTY_RESULT", "生成服务未返回图片，请稍后重试。", {
        retryable: false,
        provider: this.name
      });
    }

    if (/\bblocked\b/i.test(input.prompt)) {
      throw new ProviderError("PROVIDER_CONTENT_BLOCKED", "提示词触发供应商内容限制，未生成图片。", {
        retryable: false,
        provider: this.name
      });
    }

    const images: ProviderImage[] = [];
    for (let index = 0; index < input.quantity; index += 1) {
      notifyGenerationProgress(() => input.onStage?.({ stage: "GENERATING", imageIndex: index }));
      notifyGenerationProgress(() => input.onStage?.({ stage: "RECEIVING", imageIndex: index }));
      images.push({
        bytes: createSvg(input, index),
        mimeType: "image/svg+xml",
        width: input.width,
        height: input.height,
        index
      });
      notifyGenerationProgress(() =>
        input.onProgress?.({ completedImages: images.length, totalImages: input.quantity })
      );
    }
    return {
      providerRequestId: `mock_${input.taskId}`,
      images,
      raw: { provider: this.name, model: this.modelName }
    };
  }
}

export class OpenAiImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "openai";
  readonly modelName = resolveDefaultImageModel(this.name);
  private readonly channels: ImageChannelConfig[];
  private readonly healthStore: ChannelHealthStore;
  private readonly failoverOnTimeout: boolean;
  private readonly onChannelEvent?: (event: ImageChannelEvent) => void;
  private readonly runtimeConfig = readOpenAiGenerationRuntimeConfig();
  private readonly timeoutMs = this.runtimeConfig.timeoutMs;
  private readonly maxRetries = this.runtimeConfig.maxRetries;
  private readonly initialBackoffMs = this.runtimeConfig.initialBackoffMs;

  constructor(options: OpenAiImageGenerationProviderOptions = {}) {
    this.channels = options.channels ?? resolveImageChannels();
    if (!this.channels.length) {
      throw new Error("OPENAI_API_KEY is required (or configure IMAGE_CHANNELS with at least one enabled channel)");
    }
    this.failoverOnTimeout = options.failoverOnTimeout ?? envBool("IMAGE_CHANNEL_FAILOVER_ON_TIMEOUT", false);
    this.onChannelEvent = options.onChannelEvent;
    this.healthStore =
      options.healthStore ??
      createResilientChannelHealthStore(createChannelHealthStore(), (error, operation) => {
        this.onChannelEvent?.({
          type: "health_store_degraded",
          operation,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const modelConfig = input.modelSnapshot
      ? modelFromSnapshot(input.modelSnapshot, input.model)
      : getImageModelConfig(resolveProviderModel(input.model, this.name));
    const model = modelConfig.modelId;
    validateImageModelOptions(modelConfig, input);
    if (modelConfig.provider !== this.name) {
      throw new ProviderError("PROVIDER_BAD_RESPONSE", `OpenAI provider does not support model "${model}"`, {
        retryable: false,
        provider: this.name
      });
    }
    if (input.referenceImageUrl?.trim()) {
      throw new ProviderError(
        "PROVIDER_BAD_RESPONSE",
        "图生图暂未接入已验证的 OpenAI images edits 端点，不能把参考图 URL 当文本提示词伪装成图生图。",
        {
          retryable: false,
          provider: this.name
        }
      );
    }

    const size = imageRequestSize(modelConfig, input.aspectRatio);
    const quality = openAiQuality(input.quality);
    const images: ProviderImage[] = [];
    const requestIds = new Set<string>();
    const usedChannels: string[] = [];
    let providerCostCents = 0;

    // 按张切换而非按任务重跑：第 N 张失败时前面的图已在旧渠道出图并计费，
    // 整任务换渠道重跑等于重复付费。
    for (let index = 0; index < input.quantity; index += 1) {
      const attempt = await this.generateSingleImage(input, index, modelConfig, size, quality);
      if (attempt.requestId) {
        requestIds.add(attempt.requestId);
      }
      usedChannels.push(attempt.channel.name);
      providerCostCents += channelCostCentsPerImage(
        attempt.channel,
        modelConfig,
        input.quality,
        openAiSize(input.width, input.height)
      );
      images.push({
        bytes: attempt.image.bytes,
        mimeType: attempt.image.mimeType,
        width: input.width,
        height: input.height,
        index
      });
      notifyGenerationProgress(() =>
        input.onProgress?.({ completedImages: images.length, totalImages: input.quantity })
      );
    }

    if (!images.length) {
      throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI 未返回任何图片。", {
        retryable: false,
        provider: this.name
      });
    }

    return {
      providerRequestId: requestIds.size === 1 ? [...requestIds][0] : `openai_${input.taskId}`,
      images,
      // 命中哪个渠道就按哪个渠道记账，避免多渠道定价不同导致毛利报表失真
      providerCostCents: Math.round(providerCostCents),
      channels: usedChannels,
      raw: {
        provider: this.name,
        model,
        upstreamModel: modelConfig.upstreamModel,
        requestIds: [...requestIds],
        responseImageCount: images.length,
        channels: usedChannels
      }
    };
  }

  /** 运维查看渠道池与熔断状态 */
  async channelHealth(): Promise<ImageChannelHealthReport> {
    const states = await this.healthStore.snapshot(this.channels.map((channel) => channel.name));
    return {
      provider: this.healthStore.provider,
      channels: this.channels.map((channel, index) => ({
        name: channel.name,
        baseUrl: channel.baseUrl,
        priority: channel.priority,
        tripped: states[index]?.tripped ?? false,
        failures: states[index]?.failures ?? 0
      }))
    };
  }

  async close(): Promise<void> {
    await this.healthStore.close();
  }

  private async generateSingleImage(
    input: GenerateImageInput,
    imageIndex: number,
    modelConfig: ProviderModelConfig,
    size: OpenAiImageSize,
    quality: OpenAiImageQuality
  ): Promise<ChannelAttemptOutcome> {
    const candidates = (await this.orderCandidateChannels(modelConfig, input.modelSnapshot)).filter((channel) =>
      (channel.aspectRatios ?? modelConfig.aspectRatios).includes(input.aspectRatio)
    );
    if (!candidates.length) {
      throw new ProviderError("PROVIDER_FAILED", "所选模型暂无可用的生图通道，请联系管理员。", {
        retryable: false,
        provider: this.name
      });
    }
    let lastError: ProviderError | null = null;

    for (let position = 0; position < candidates.length; position += 1) {
      const channel = candidates[position];
      const hasRemainingChannel = position < candidates.length - 1;
      try {
        const outcome = await this.requestChannelImage(channel, input, modelConfig, size, quality, imageIndex);
        await this.healthStore.recordSuccess(channel.name);
        this.onChannelEvent?.({
          type: "channel_succeeded",
          channel: channel.name,
          taskId: input.taskId,
          imageIndex
        });
        return outcome;
      } catch (error) {
        const providerError = normalizeProviderError(error, this.name);

        // 内容拦截换渠道也一样被拦，直接失败，别浪费额度和时间
        if (!isChannelFailureSignal(providerError)) {
          throw providerError;
        }

        // 超时代表请求已发出、上游可能仍在出图，换渠道重发会双份计费。
        // 但仍记入熔断：后续任务自动绕开这个摆烂的渠道。
        const canFailover = providerError.code !== "PROVIDER_TIMEOUT" || this.failoverOnTimeout;
        const tripped = await this.healthStore.recordFailure(channel.name);
        this.onChannelEvent?.({
          type: "channel_failed",
          channel: channel.name,
          taskId: input.taskId,
          imageIndex,
          code: providerError.code,
          statusCode: providerError.statusCode,
          message: providerError.message,
          tripped,
          willFailover: canFailover && hasRemainingChannel
        });

        if (!canFailover) {
          throw providerError;
        }
        lastError = providerError;
      }
    }

    throw (
      lastError ??
      new ProviderError("PROVIDER_FAILED", "所有图像渠道均不可用，请稍后重试。", {
        retryable: true,
        provider: this.name
      })
    );
  }

  /**
   * 健康渠道优先，冷却中的渠道降级到队尾而不是直接剔除：
   * 全部渠道都在冷却时仍要尝试出图，熔断不能变成全站停摆。
   */
  private async orderCandidateChannels(
    modelConfig: ProviderModelConfig,
    snapshot?: ImageGenerationSnapshot
  ): Promise<ImageChannelConfig[]> {
    const healthy: ImageChannelConfig[] = [];
    const cooling: ImageChannelConfig[] = [];
    const candidates = snapshot
      ? snapshot.channels.flatMap((saved) => {
          const current = this.channels.find(
            (channel) => channel.name === saved.name && channel.baseUrl === saved.baseUrl && channel.enabled
          );
          return current ? [{ ...current, ...saved }] : [];
        })
      : resolveModelChannels(modelConfig, this.channels);
    for (const channel of candidates) {
      if (await this.healthStore.isTripped(channel.name)) {
        cooling.push(channel);
      } else {
        healthy.push(channel);
      }
    }
    return [...healthy, ...cooling];
  }

  private async requestChannelImage(
    channel: ImageChannelConfig,
    input: GenerateImageInput,
    modelConfig: ProviderModelConfig,
    size: OpenAiImageSize,
    quality: OpenAiImageQuality,
    imageIndex: number
  ): Promise<ChannelAttemptOutcome> {
    const payload = await this.requestGeneration(
      channel,
      {
        model: channel.upstreamModel ?? modelConfig.upstreamModel,
        prompt: buildPrompt(input),
        n: 1,
        response_format: "b64_json",
        ...(modelConfig.apiFormat === "grok-image" ? { aspect_ratio: input.aspectRatio } : { size }),
        ...(modelConfig.apiFormat === "gpt-image" ? { quality, output_format: "png" } : {})
      },
      1,
      (stage) => input.onStage?.({ stage, imageIndex })
    );
    const image = await extractOpenAiImage(payload.data[0], payload, {
      timeoutMs: Math.min(this.resolveRequestTimeoutMs(1), DEFAULT_OPENAI_REMOTE_IMAGE_TIMEOUT_MS),
      allowInsecureLocalhost: isLocalHttpUrl(channel.baseUrl)
    });
    if (!image.bytes) {
      throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI 未返回图片数据。", {
        retryable: false,
        provider: this.name,
        details: payload
      });
    }
    return {
      channel,
      image,
      ...(payload.id ? { requestId: payload.id } : {})
    };
  }

  private async requestGeneration(
    channel: ImageChannelConfig,
    body: OpenAiGenerationRequestBody,
    quantity: number,
    onStage?: (stage: "GENERATING" | "RECEIVING") => void | Promise<void>
  ): Promise<NormalizedOpenAiImageResponse> {
    let attempt = 0;
    while (true) {
      try {
        return await this.performRequest(channel, body, quantity, onStage);
      } catch (error) {
        const providerError = normalizeProviderError(error, this.name);
        if (!shouldRetryOpenAiRequest(providerError) || attempt >= this.maxRetries) {
          throw providerError;
        }
        attempt += 1;
        await sleep(this.initialBackoffMs * 2 ** (attempt - 1));
      }
    }
  }

  private async performRequest(
    channel: ImageChannelConfig,
    body: OpenAiGenerationRequestBody,
    quantity: number,
    onStage?: (stage: "GENERATING" | "RECEIVING") => void | Promise<void>
  ): Promise<NormalizedOpenAiImageResponse> {
    notifyGenerationProgress(() => onStage?.("GENERATING"));
    const signal = AbortSignal.timeout(this.resolveRequestTimeoutMs(quantity));
    let response: Response;
    try {
      response = await fetch(`${channel.baseUrl}/images/generations`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${channel.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw openAiTimeoutError(error);
      }
      throw new ProviderError("PROVIDER_FAILED", "连接 OpenAI 失败，请稍后重试。", {
        retryable: true,
        provider: this.name,
        details: error
      });
    }

    // 先启动正文读取。进度持久化不能占用图片接收的剩余超时预算。
    const payloadPromise = response.json();
    if (response.ok) notifyGenerationProgress(() => onStage?.("RECEIVING"));
    let payload: OpenAiImageResponse;
    try {
      const parsed: unknown = await payloadPromise;
      payload = isRecord(parsed) ? parsed : {};
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw openAiTimeoutError(error);
      }
      if (!(error instanceof SyntaxError)) {
        throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI 响应正文读取失败，请稍后重试。", {
          retryable: false,
          provider: this.name,
          statusCode: response.status,
          details: error
        });
      }
      // 非 JSON 响应仍按 HTTP 状态映射；成功状态下则报告格式异常。
      payload = {};
    }
    if (!response.ok) {
      throw mapOpenAiError(response.status, payload, this.name);
    }

    return normalizeOpenAiSuccessPayload(payload, response.status);
  }

  private resolveRequestTimeoutMs(quantity: number): number {
    return this.timeoutMs * Math.max(1, Math.trunc(quantity));
  }
}

/**
 * 判定失败是否属于「这个渠道不行」的信号：
 * 鉴权失败（key 挂了/余额清零）、限流、5xx、连接失败、返回格式垃圾都算，
 * 内容拦截不算（换渠道同样被拦）。
 */
function isChannelFailureSignal(error: ProviderError): boolean {
  switch (error.code) {
    case "PROVIDER_CONTENT_BLOCKED":
      return false;
    case "PROVIDER_AUTH_FAILED":
    case "PROVIDER_RATE_LIMITED":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_EMPTY_RESULT":
    case "PROVIDER_FAILED":
      return true;
    case "PROVIDER_BAD_RESPONSE":
      // 4xx 参数错误换渠道也一样错；5xx 与格式异常才是渠道问题
      return error.statusCode === undefined || error.statusCode >= 500;
  }
}

function channelCostCentsPerImage(
  channel: ImageChannelConfig,
  modelConfig: ProviderModelConfig,
  quality: Quality,
  size: ImageSize
): number {
  const baseCost = channel.costCentsPerImage ?? modelConfig.costCentsPerImage;
  return baseCost * modelConfig.qualityMultiplier[quality] * modelConfig.sizeMultiplier[size];
}

export function resolveDefaultImageProvider(): SupportedProviderName {
  const configuredProvider = firstNonEmptyEnv("IMAGE_PROVIDER_DEFAULT", "AI_PROVIDER");
  if (configuredProvider) {
    return normalizeProviderName(configuredProvider);
  }
  return hasConfiguredImageChannel() ? "openai" : "mock";
}

export function readOpenAiGenerationRuntimeConfig(): OpenAiGenerationRuntimeConfig {
  return {
    timeoutMs: envNumber("OPENAI_TIMEOUT_MS", DEFAULT_OPENAI_TIMEOUT_MS),
    maxRetries: envNumber("OPENAI_MAX_RETRIES", DEFAULT_OPENAI_MAX_RETRIES, true),
    initialBackoffMs: envNumber("OPENAI_RETRY_BASE_MS", 600)
  };
}

export function assertProductionOpenAiGenerationConfig(): void {
  const config = readOpenAiGenerationRuntimeConfig();
  if (config.timeoutMs < MIN_PRODUCTION_OPENAI_TIMEOUT_MS) {
    throw new Error(`Unsafe production config: OPENAI_TIMEOUT_MS must be at least ${MIN_PRODUCTION_OPENAI_TIMEOUT_MS}`);
  }
  if (config.maxRetries > MAX_PRODUCTION_OPENAI_MAX_RETRIES) {
    throw new Error(
      `Unsafe production config: OPENAI_MAX_RETRIES must be ${MAX_PRODUCTION_OPENAI_MAX_RETRIES} or less`
    );
  }
}

export function resolveDefaultImageModel(providerName = resolveDefaultImageProvider()): SupportedImageModel {
  const provider = normalizeProviderName(providerName);
  const configuredModel = process.env.IMAGE_MODEL_DEFAULT?.trim();
  if (
    configuredModel &&
    hasDiscoveredImageModels() &&
    !readImageModelConfigs().some(
      (model) =>
        model.enabled &&
        model.provider === provider &&
        model.modelId === (modelAliases[configuredModel] ?? configuredModel)
    )
  ) {
    return (
      readImageModelConfigs().find(
        (model) => model.provider === provider && model.enabled && model.modelId === DEFAULT_OPENAI_MODEL_ID
      )?.modelId ??
      readImageModelConfigs().find((model) => model.provider === provider && model.enabled)?.modelId ??
      DEFAULT_OPENAI_MODEL_ID
    );
  }
  if (configuredModel) {
    const resolvedModel = normalizeModelId(configuredModel);
    const config = getImageModelConfig(resolvedModel);
    if (config.provider !== provider || !config.enabled) {
      throw new Error(`IMAGE_MODEL_DEFAULT "${configuredModel}" does not match provider "${provider}"`);
    }
    return resolvedModel;
  }

  if (provider === "mock") {
    return MOCK_MODEL_ID;
  }

  return resolveConfiguredOpenAiModel();
}

export function getImageModelConfig(modelId: ModelId): ProviderModelConfig {
  const normalized = normalizeModelId(modelId);
  const config = readImageModelConfigs().find((model) => model.modelId === normalized);
  if (!config) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", `Unsupported image model "${normalized}".`, {
      retryable: false,
      provider: "openai"
    });
  }
  return config;
}

export function createImageGenerationProvider(
  name: string = resolveDefaultImageProvider(),
  options: OpenAiImageGenerationProviderOptions = {}
): ImageGenerationProvider {
  switch (normalizeProviderName(name)) {
    case "mock":
      return new MockImageGenerationProvider();
    case "openai":
      return new OpenAiImageGenerationProvider(options);
  }
}

export function getActiveProviderMetadata(name = resolveDefaultImageProvider()): ProviderMetadata {
  const normalized = normalizeProviderName(name);
  return {
    name: normalized,
    modelName: resolveDefaultImageModel(normalized)
  };
}

export function listSupportedModels(name?: string): SupportedImageModel[] {
  const provider = name ? normalizeProviderName(name) : undefined;
  return readImageModelConfigs()
    .filter((model) => model.enabled && (!provider || model.provider === provider))
    .map((model) => model.modelId);
}

export function getImageModelCatalog(name = resolveDefaultImageProvider()): {
  models: PublicImageModel[];
  defaultModel: string | null;
} {
  const provider = normalizeProviderName(name);
  const channels = provider === "openai" ? resolveImageChannels() : [];
  const models = readImageModelConfigs()
    .filter((model) => model.enabled && model.provider === provider)
    .filter((model) => provider === "mock" || resolveModelChannels(model, channels).length > 0)
    .map(publicImageModel);
  if (!models.length) return { models, defaultModel: null };
  const preferred = resolveDefaultImageModel(provider);
  return { models, defaultModel: models.find((model) => model.id === preferred)?.id ?? models[0].id };
}

export function resolveProviderModel(
  inputModel?: ModelId,
  providerName = resolveDefaultImageProvider()
): SupportedImageModel {
  const provider = normalizeProviderName(providerName);
  const requestedModel = inputModel ? normalizeModelId(inputModel) : resolveDefaultImageModel(provider);

  const config = readImageModelConfigs().find((model) => model.modelId === requestedModel);
  if (!config || !config.enabled || config.provider !== provider) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      `Provider "${provider}" does not support model "${requestedModel}".`,
      {
        retryable: false,
        provider
      }
    );
  }

  if (config.channels && !resolveModelChannels(config, resolveImageChannels()).length) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "所选模型暂无可用的生图通道，请联系管理员。", {
      retryable: false,
      provider
    });
  }

  return requestedModel;
}

export function quoteImageGeneration(input: QuoteImageGenerationInput): ImageGenerationQuote {
  const provider = normalizeProviderName(
    input.modelSnapshot?.model.provider ?? input.provider ?? resolveDefaultImageProvider()
  );
  const config = input.modelSnapshot
    ? modelFromSnapshot(input.modelSnapshot, input.model)
    : getImageModelConfig(resolveProviderModel(input.model, provider));
  const model = config.modelId;
  validateImageModelOptions(config, input);
  const dimension = aspectRatioDimensions[input.aspectRatio];
  const size = openAiSize(dimension.width, dimension.height);
  const quality = openAiQuality(input.quality);
  const modelUnitCost =
    config.quantityMultiplier * config.qualityMultiplier[input.quality] * config.sizeMultiplier[size];
  // 供应商成本随质量/尺寸缩放，与计费口径一致，便于后续毛利核算
  const providerCostPerImage =
    config.costCentsPerImage * config.qualityMultiplier[input.quality] * config.sizeMultiplier[size];
  const creditCost = Math.ceil(modelUnitCost * input.quantity) * (config.creditMultiplier ?? 1);
  const providerCostCents = Math.round(providerCostPerImage * input.quantity);
  if (!Number.isSafeInteger(creditCost) || creditCost < 1 || !Number.isSafeInteger(providerCostCents)) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "所选模型的计费配置无效，请联系管理员。", {
      retryable: false,
      provider
    });
  }
  return {
    provider,
    model,
    creditCost,
    providerCostCents,
    ...imageDimensions(config, input.aspectRatio),
    size: imageRequestSize(config, input.aspectRatio),
    quality
  };
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

function normalizeProviderName(name: string): SupportedProviderName {
  const normalized = name.trim().toLowerCase();
  if (normalized === "mock" || normalized === "openai") {
    return normalized;
  }
  throw new Error(`Unsupported AI provider: ${name}`);
}

function firstNonEmptyEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeModelId(modelId: ModelId): SupportedImageModel {
  const normalized = modelId.trim();
  const resolved = modelAliases[normalized] ?? normalized;
  if (readImageModelConfigs().some((model) => model.modelId === resolved)) {
    return resolved;
  }
  throw new Error(`Unsupported image model: ${modelId}`);
}

function resolveConfiguredOpenAiModel(): SupportedImageModel {
  const value = process.env.OPENAI_IMAGE_MODEL?.trim();
  if (!value) {
    return (
      readImageModelConfigs().find((model) => model.provider === "openai" && model.enabled)?.modelId ??
      DEFAULT_OPENAI_MODEL_ID
    );
  }
  const modelId = normalizeModelId(value);
  const config = getImageModelConfig(modelId);
  if (config.provider !== "openai" || !config.enabled) {
    throw new Error(`Unsupported OPENAI_IMAGE_MODEL: ${value}`);
  }
  return modelId;
}

function validateImageModelOptions(
  model: ProviderModelConfig,
  input: Pick<GenerateImageInput, "quality" | "aspectRatio" | "quantity">
): void {
  let message: string | undefined;
  if (!model.aspectRatios.length) message = "该型号的可用画面比例尚未确认，请选择其他模型。";
  else if (!model.qualities.includes(input.quality)) message = "所选模型不支持当前画质，请重新选择。";
  else if (!model.aspectRatios.includes(input.aspectRatio)) message = "所选模型不支持当前画面比例，请重新选择。";
  else if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > model.maxQuantity) {
    message = `所选模型每次最多生成 ${model.maxQuantity} 张图片。`;
  }
  if (message)
    throw new ProviderError("PROVIDER_BAD_RESPONSE", message, { retryable: false, provider: model.provider });
}

function notifyGenerationProgress(callback: () => void | Promise<void>): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // 通知失败不能丢弃已生成图片，也不能触发重试或渠道切换。
  }
}

function openAiTimeoutError(error: unknown): ProviderError {
  return new ProviderError("PROVIDER_TIMEOUT", "OpenAI 图片生成超时，请稍后重试。", {
    retryable: true,
    provider: "openai",
    details: error
  });
}

function normalizeProviderError(error: unknown, provider: SupportedProviderName): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (isAbortError(error)) {
    return new ProviderError("PROVIDER_TIMEOUT", "供应商请求超时。", {
      retryable: true,
      provider
    });
  }
  return new ProviderError("PROVIDER_FAILED", error instanceof Error ? error.message : "供应商请求失败。", {
    retryable: true,
    provider,
    details: error
  });
}

function shouldRetryOpenAiRequest(error: ProviderError): boolean {
  // 图片生成超时后上游任务可能仍在执行，自动重试会放大重复计费/重复扣模型额度风险。
  return error.retryable && error.code !== "PROVIDER_TIMEOUT";
}

function normalizeOpenAiSuccessPayload(
  payload: OpenAiImageResponse,
  statusCode: number
): NormalizedOpenAiImageResponse {
  const normalizedItems = extractOpenAiImageItems(payload);
  if (!normalizedItems) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI 返回格式异常。", {
      retryable: false,
      provider: "openai",
      statusCode,
      details: payload
    });
  }

  return {
    ...payload,
    data: normalizedItems
  };
}

async function extractOpenAiImage(
  item: OpenAiImageItem | undefined,
  payload: OpenAiImageResponse,
  remoteImageOptions: OpenAiRemoteImageFetchOptions
): Promise<{
  bytes: string;
  mimeType: ProviderImage["mimeType"];
}> {
  const rawImagePayload = item?.b64_json?.trim();
  const imageData = looksLikeRemoteImageUrl(rawImagePayload) ? null : normalizeBase64ImagePayload(rawImagePayload);
  if (imageData) {
    return {
      bytes: imageData.bytes,
      mimeType: imageData.mimeType ?? item?.mimeType ?? "image/png"
    };
  }

  const remoteImageUrl = firstRemoteImageUrl(rawImagePayload, item?.url);
  if (remoteImageUrl) {
    return fetchOpenAiRemoteImage(remoteImageUrl, remoteImageOptions, payload);
  }

  throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI 未返回图片数据。", {
    retryable: false,
    provider: "openai",
    details: payload
  });
}

function extractOpenAiImageItems(payload: OpenAiImageResponse): OpenAiImageItem[] | null {
  const sources = [payload.data, payload.images, payload.output];
  for (const source of sources) {
    const normalized = normalizeOpenAiImageItems(source, true);
    if (normalized) {
      return normalized;
    }
  }

  const directItem = normalizeOpenAiImageItem(payload);
  if (directItem) {
    return [directItem];
  }

  return null;
}

function normalizeOpenAiImageItems(source: unknown, preserveEmptyRecord: boolean): OpenAiImageItem[] | null {
  if (Array.isArray(source)) {
    return source.map((item) => normalizeOpenAiImageItem(item, preserveEmptyRecord) ?? {});
  }
  if (source && typeof source === "object") {
    return [normalizeOpenAiImageItem(source, preserveEmptyRecord) ?? {}];
  }
  if (typeof source === "string") {
    const directItem = normalizeOpenAiImageItem(source, preserveEmptyRecord);
    return directItem ? [directItem] : preserveEmptyRecord ? [{}] : null;
  }
  return null;
}

function normalizeOpenAiImageItem(source: unknown, preserveEmptyRecord = false): OpenAiImageItem | null {
  if (typeof source === "string") {
    const normalized = source.trim();
    if (!normalized) {
      return preserveEmptyRecord ? {} : null;
    }
    return { b64_json: normalized };
  }

  if (!isRecord(source)) {
    return preserveEmptyRecord ? {} : null;
  }

  const nestedImage = isRecord(source.image) ? source.image : undefined;
  const b64Json = firstNonEmptyString(
    source.b64_json,
    source.image_base64,
    source.image,
    source.base64,
    source.result,
    nestedImage?.b64_json,
    nestedImage?.image_base64,
    nestedImage?.image,
    nestedImage?.base64,
    nestedImage?.result
  );
  const url = firstNonEmptyString(source.url, nestedImage?.url);
  const mimeType = normalizeGeneratedImageMimeType(
    firstNonEmptyString(
      source.mime_type,
      source.mimeType,
      source.content_type,
      source.contentType,
      nestedImage?.mime_type,
      nestedImage?.mimeType,
      nestedImage?.content_type,
      nestedImage?.contentType
    )
  );

  if (b64Json || url || mimeType) {
    return {
      ...(b64Json ? { b64_json: b64Json } : {}),
      ...(url ? { url } : {}),
      ...(mimeType ? { mimeType } : {})
    };
  }

  const nestedItem = pickResolvedOpenAiImageItem([
    ...(normalizeOpenAiImageItems(source.content, false) ?? []),
    ...(normalizeOpenAiImageItems(source.result, false) ?? []),
    ...(normalizeOpenAiImageItems(source.data, false) ?? [])
  ]);
  if (nestedItem) {
    return nestedItem;
  }

  if (preserveEmptyRecord) {
    return {};
  }

  return null;
}

function pickResolvedOpenAiImageItem(items: OpenAiImageItem[]): OpenAiImageItem | null {
  const imageItem = items.find((item) => item.b64_json || item.url);
  if (imageItem) {
    return imageItem;
  }

  const mimeOnlyItem = items.find((item) => item.mimeType);
  return mimeOnlyItem ?? null;
}

function normalizeBase64ImagePayload(
  value: string | undefined
): { bytes: string; mimeType?: ProviderImage["mimeType"] } | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const dataUrlMatch = normalized.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!dataUrlMatch) {
    return { bytes: normalized };
  }

  return {
    bytes: dataUrlMatch[2].trim(),
    mimeType: normalizeGeneratedImageMimeType(dataUrlMatch[1])
  };
}

function normalizeGeneratedImageMimeType(value: string | undefined): ProviderImage["mimeType"] | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  if (
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp" ||
    normalized === "image/svg+xml"
  ) {
    return normalized;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function looksLikeRemoteImageUrl(value: string | undefined): boolean {
  return /^(https?:)?\/\//i.test(value?.trim() ?? "");
}

function firstRemoteImageUrl(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized && looksLikeRemoteImageUrl(normalized)) {
      return normalized.startsWith("//") ? `https:${normalized}` : normalized;
    }
  }
  return undefined;
}

async function fetchOpenAiRemoteImage(
  urlValue: string,
  options: OpenAiRemoteImageFetchOptions,
  payload: OpenAiImageResponse
): Promise<{
  bytes: string;
  mimeType: ProviderImage["mimeType"];
}> {
  const url = normalizeFetchableOpenAiImageUrl(urlValue, options.allowInsecureLocalhost, payload);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "manual"
    });
  } catch (error) {
    throw new ProviderError("PROVIDER_FAILED", "OpenAI-compatible 图像网关返回了 URL 图片，但后端下载图片失败。", {
      retryable: true,
      provider: "openai",
      details: {
        url: redactImageUrl(url),
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }

  if (!response.ok) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "OpenAI-compatible 图像网关返回了 URL 图片，但图片地址不可读取。",
      {
        retryable: false,
        provider: "openai",
        statusCode: response.status,
        details: {
          url: redactImageUrl(url),
          statusText: response.statusText
        }
      }
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_OPENAI_REMOTE_IMAGE_BYTES) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI-compatible 图像网关返回的 URL 图片过大。", {
      retryable: false,
      provider: "openai",
      details: {
        url: redactImageUrl(url),
        contentLength,
        maxBytes: MAX_OPENAI_REMOTE_IMAGE_BYTES
      }
    });
  }

  const mimeType = normalizeGeneratedImageMimeType(response.headers.get("content-type") ?? undefined);
  if (!mimeType) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "OpenAI-compatible 图像网关返回的 URL 图片不是受支持的图片类型。",
      {
        retryable: false,
        provider: "openai",
        details: {
          url: redactImageUrl(url),
          contentType: response.headers.get("content-type")
        }
      }
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI-compatible 图像网关返回的 URL 图片为空。", {
      retryable: false,
      provider: "openai",
      details: {
        url: redactImageUrl(url)
      }
    });
  }
  if (bytes.byteLength > MAX_OPENAI_REMOTE_IMAGE_BYTES) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI-compatible 图像网关返回的 URL 图片过大。", {
      retryable: false,
      provider: "openai",
      details: {
        url: redactImageUrl(url),
        byteLength: bytes.byteLength,
        maxBytes: MAX_OPENAI_REMOTE_IMAGE_BYTES
      }
    });
  }

  return {
    bytes: bytes.toString("base64"),
    mimeType
  };
}

function normalizeFetchableOpenAiImageUrl(
  urlValue: string,
  allowInsecureLocalhost: boolean,
  payload: OpenAiImageResponse
): URL {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI-compatible 图像网关返回了无效图片 URL。", {
      retryable: false,
      provider: "openai",
      details: {
        responseShape: summarizeOpenAiImageResponse(payload)
      }
    });
  }

  const isLocalTarget = isLocalHostname(url.hostname);
  const isAllowedHttps = url.protocol === "https:" && (!isLocalTarget || allowInsecureLocalhost);
  const isAllowedLocalHttp = allowInsecureLocalhost && url.protocol === "http:" && isLocalHostname(url.hostname);
  if (!isAllowedHttps && !isAllowedLocalHttp) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI-compatible 图像网关返回了不可下载的图片 URL。", {
      retryable: false,
      provider: "openai",
      details: {
        url: redactImageUrl(url),
        responseShape: summarizeOpenAiImageResponse(payload)
      }
    });
  }

  if (url.username || url.password) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI-compatible 图像网关返回的图片 URL 包含不安全凭据。", {
      retryable: false,
      provider: "openai",
      details: {
        url: redactImageUrl(url),
        responseShape: summarizeOpenAiImageResponse(payload)
      }
    });
  }

  return url;
}

function summarizeOpenAiImageResponse(payload: OpenAiImageResponse): Record<string, boolean> {
  return {
    hasData: payload.data !== undefined,
    hasImages: payload.images !== undefined,
    hasOutput: payload.output !== undefined,
    hasResult: payload.result !== undefined,
    hasDirectImage: payload.image !== undefined,
    hasDirectBase64: payload.b64_json !== undefined || payload.image_base64 !== undefined
  };
}

function redactImageUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapOpenAiError(status: number, payload: OpenAiImageResponse, provider: SupportedProviderName): ProviderError {
  const message = payload.error?.message ?? `OpenAI returned ${status}`;
  const code = payload.error?.code?.toLowerCase() ?? "";
  const type = payload.error?.type?.toLowerCase() ?? "";
  const statusCode = status;

  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_AUTH_FAILED", formatOpenAiAuthFailureMessage(message), {
      retryable: false,
      provider,
      statusCode,
      details: payload
    });
  }

  if (
    status === 400 &&
    (code.includes("content_policy") ||
      code.includes("safety") ||
      code.includes("moderation") ||
      type.includes("content_policy"))
  ) {
    return new ProviderError("PROVIDER_CONTENT_BLOCKED", message, {
      retryable: false,
      provider,
      statusCode,
      details: payload
    });
  }

  if (status === 429) {
    return new ProviderError("PROVIDER_RATE_LIMITED", message, {
      retryable: true,
      provider,
      statusCode,
      details: payload
    });
  }

  if (status >= 500) {
    return new ProviderError("PROVIDER_FAILED", message, {
      retryable: true,
      provider,
      statusCode,
      details: payload
    });
  }

  return new ProviderError("PROVIDER_BAD_RESPONSE", message, {
    retryable: false,
    provider,
    statusCode,
    details: payload
  });
}

function formatOpenAiAuthFailureMessage(message: string): string {
  const normalized = message.trim() || "上游返回未授权。";
  return `图像供应商鉴权失败，请检查 OPENAI_API_KEY 与 OPENAI_BASE_URL 配置。上游返回：${normalized}`;
}

function buildPrompt(input: GenerateImageInput): string {
  const parts = [
    input.prompt,
    input.style !== "none" ? `Style: ${input.style.replace(/_/g, " ")}` : null,
    `Aspect ratio: ${input.aspectRatio}`,
    input.negativePrompt ? `Avoid: ${input.negativePrompt}` : null
  ];
  return parts.filter(Boolean).join("\n");
}

function openAiSize(width: number, height: number): ImageSize {
  if (width === height) {
    return "1024x1024";
  }
  return height > width ? "1024x1536" : "1536x1024";
}

function openAiQuality(quality: Quality): OpenAiImageQuality {
  switch (quality) {
    case "draft":
      return "low";
    case "standard":
      return "medium";
    case "high":
      return "high";
  }
}

function envNumber(name: string, fallback: number, allowZero = false): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createSvg(input: GenerateImageInput, index: number): string {
  const palette = stylePalette(input.style);
  const title = escapeXml(styleTitle(input.style));
  const prompt = escapeXml(input.prompt.slice(0, 140));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${palette[0]}"/>
      <stop offset="54%" stop-color="${palette[1]}"/>
      <stop offset="100%" stop-color="${palette[2]}"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="24" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${input.width * 0.72}" cy="${input.height * 0.28}" r="${Math.min(input.width, input.height) * 0.18}" fill="rgba(255,255,255,0.34)" filter="url(#glow)"/>
  <path d="M0 ${input.height * 0.72} C ${input.width * 0.26} ${input.height * 0.42}, ${input.width * 0.58} ${input.height * 0.98}, ${input.width} ${input.height * 0.58} L ${input.width} ${input.height} L 0 ${input.height} Z" fill="rgba(7,7,10,0.48)"/>
  <g font-family="Noto Sans SC,Microsoft YaHei,Arial,sans-serif" fill="white">
    <text x="7%" y="12%" font-size="${Math.max(28, input.width * 0.042)}" font-weight="800">${title}</text>
    <text x="7%" y="20%" font-size="${Math.max(18, input.width * 0.021)}" opacity="0.78">Imagora 生成预览 ${index + 1}/${input.quantity}</text>
    <foreignObject x="7%" y="72%" width="82%" height="20%">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font: 600 ${Math.max(18, input.width * 0.022)}px Noto Sans SC,Microsoft YaHei,Arial,sans-serif; line-height:1.35; color:white;">${prompt}</div>
    </foreignObject>
  </g>
</svg>`;
}

function styleTitle(style: StyleId): string {
  switch (style) {
    case "none":
      return "自由创作";
    case "realistic":
      return "写实视觉";
    case "illustration":
      return "商业插画";
    case "anime":
      return "动漫插画";
    case "product_photography":
      return "产品摄影";
    case "poster":
      return "海报设计";
  }
}

function stylePalette(style: StyleId): [string, string, string] {
  switch (style) {
    case "none":
      return ["#101116", "#58f0b6", "#f8fbff"];
    case "realistic":
      return ["#101116", "#ff6b35", "#25d8ff"];
    case "illustration":
      return ["#07070a", "#58f0b6", "#d9f85b"];
    case "anime":
      return ["#25d8ff", "#ff4db8", "#5f43ff"];
    case "product_photography":
      return ["#101116", "#58f0b6", "#f8fbff"];
    case "poster":
      return ["#ff6b35", "#d9f85b", "#ff4db8"];
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createImageGenerationSnapshot(modelId?: ModelId): ImageGenerationSnapshot {
  const model = getImageModelConfig(resolveProviderModel(modelId));
  return {
    version: 1,
    model: structuredClone(model),
    channels: resolveModelChannels(model, resolveImageChannels()).map(
      ({ name, baseUrl, priority, upstreamModel, costCentsPerImage, aspectRatios }) => ({
        name,
        baseUrl,
        priority,
        upstreamModel,
        costCentsPerImage,
        aspectRatios
      })
    )
  };
}

function modelFromSnapshot(snapshot: ImageGenerationSnapshot, requestedModel?: ModelId): ProviderModelConfig {
  if (snapshot.version !== 1 || (requestedModel && requestedModel !== snapshot.model.modelId)) {
    throw new Error("任务模型快照与所选模型不一致");
  }
  return snapshot.model;
}

const GPT_IMAGE_4K_MAX_EDGE = 4096;
const GPT_IMAGE_ALIGNMENT = 16;

function imageDimensions(config: ProviderModelConfig, ratio: AspectRatio): { width: number; height: number } {
  if (config.resolution !== "4k") return aspectRatioDimensions[ratio];

  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
  const edgeScale = GPT_IMAGE_4K_MAX_EDGE / Math.max(ratioWidth, ratioHeight);
  const alignDown = (value: number) => Math.floor(value / GPT_IMAGE_ALIGNMENT) * GPT_IMAGE_ALIGNMENT;
  const dimensions = {
    width: alignDown(ratioWidth * edgeScale),
    height: alignDown(ratioHeight * edgeScale)
  };

  // 第三方 GPT Image 4K 网关按比例使用长边 4096；宽高对齐到 16 像素，避免把 4K 错误限制成只有方形。
  if (
    dimensions.width < GPT_IMAGE_ALIGNMENT ||
    dimensions.height < GPT_IMAGE_ALIGNMENT ||
    Math.max(dimensions.width, dimensions.height) > GPT_IMAGE_4K_MAX_EDGE
  ) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", `4K 比例 ${ratio} 无法映射到供应商支持的尺寸。`, {
      retryable: false,
      provider: config.provider
    });
  }

  return dimensions;
}
function imageRequestSize(config: ProviderModelConfig, ratio: AspectRatio): OpenAiImageSize {
  const dimensions = imageDimensions(config, ratio);
  return `${dimensions.width}x${dimensions.height}`;
}

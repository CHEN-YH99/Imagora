import { aspectRatioDimensions, type AspectRatio, type ModelId, type Quality, type StyleId } from "@imagora/shared";

export const DEFAULT_OPENAI_MODEL = "gpt-image-2" as const;
export const MOCK_MODEL = "mock" as const;
export const DEFAULT_OPENAI_MODEL_ID = "openai:gpt-image-2" as const;
export const MOCK_MODEL_ID = "mock:default" as const;
export const SUPPORTED_IMAGE_MODELS = [DEFAULT_OPENAI_MODEL_ID, MOCK_MODEL_ID] as const;

type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];
type SupportedProviderName = "mock" | "openai";
type OpenAiImageSize = "1024x1024" | "1024x1536" | "1536x1024";
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
  referenceImageUrl?: string | null;
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
  raw?: unknown;
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

export interface QuoteImageGenerationInput {
  style: StyleId;
  quality: Quality;
  quantity: number;
  aspectRatio: AspectRatio;
  model?: ModelId;
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

interface ProviderModelConfig {
  provider: SupportedProviderName;
  modelId: SupportedImageModel;
  upstreamModel: string;
  label: string;
  qualityMultiplier: Record<Quality, number>;
  sizeMultiplier: Record<OpenAiImageSize, number>;
  quantityMultiplier: number;
  // 供应商侧每张图的真实美元成本（分），用于毛利核算；mock 为 0
  costCentsPerImage: number;
}

interface OpenAiImageResponse {
  id?: string;
  data?: OpenAiImageItem[];
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
}

const providerModelConfigs: Record<SupportedImageModel, ProviderModelConfig> = {
  [DEFAULT_OPENAI_MODEL_ID]: {
    provider: "openai",
    modelId: DEFAULT_OPENAI_MODEL_ID,
    upstreamModel: DEFAULT_OPENAI_MODEL,
    label: "GPT Image 2",
    qualityMultiplier: {
      draft: 0.75,
      standard: 1,
      high: 1.7
    },
    sizeMultiplier: {
      "1024x1024": 1,
      "1024x1536": 1.22,
      "1536x1024": 1.22
    },
    quantityMultiplier: 7,
    costCentsPerImage: 4
  },
  [MOCK_MODEL_ID]: {
    provider: "mock",
    modelId: MOCK_MODEL_ID,
    upstreamModel: MOCK_MODEL,
    label: "Imagora Mock",
    qualityMultiplier: {
      draft: 0.4,
      standard: 0.65,
      high: 1
    },
    sizeMultiplier: {
      "1024x1024": 1,
      "1024x1536": 1.1,
      "1536x1024": 1.1
    },
    quantityMultiplier: 4,
    costCentsPerImage: 0
  }
};

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

    return {
      providerRequestId: `mock_${input.taskId}`,
      images: Array.from({ length: input.quantity }, (_, index) => ({
        bytes: createSvg(input, index),
        mimeType: "image/svg+xml",
        width: input.width,
        height: input.height,
        index
      })),
      raw: { provider: this.name, model: this.modelName }
    };
  }
}

export class OpenAiImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "openai";
  readonly modelName = resolveDefaultImageModel(this.name);
  private readonly apiKey = requiredEnv("OPENAI_API_KEY");
  private readonly baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  private readonly timeoutMs = envNumber("OPENAI_TIMEOUT_MS", 120_000);
  private readonly maxRetries = envNumber("OPENAI_MAX_RETRIES", 2, true);
  private readonly initialBackoffMs = envNumber("OPENAI_RETRY_BASE_MS", 600);

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const model = resolveProviderModel(input.model, this.name);
    const modelConfig = getImageModelConfig(model);
    if (modelConfig.provider !== this.name) {
      throw new ProviderError("PROVIDER_BAD_RESPONSE", `OpenAI provider does not support model "${model}"`, {
        retryable: false,
        provider: this.name
      });
    }

    const size = openAiSize(input.width, input.height);
    const quality = openAiQuality(input.quality);
    const images: ProviderImage[] = [];
    const requestIds = new Set<string>();

    for (let index = 0; index < input.quantity; index += 1) {
      const payload = await this.requestGeneration({
        model: modelConfig.upstreamModel,
        prompt: buildPrompt(input),
        size,
        quality,
        n: 1,
        output_format: "png"
      });
      if (payload.id) {
        requestIds.add(payload.id);
      }
      const item = payload.data?.[0];
      const bytes = extractOpenAiImageBytes(item, payload);
      if (!bytes) {
        throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI 未返回图片数据。", {
          retryable: false,
          provider: this.name,
          details: payload
        });
      }
      images.push({
        bytes,
        mimeType: "image/png",
        width: input.width,
        height: input.height,
        index
      });
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
      raw: { provider: this.name, model, upstreamModel: modelConfig.upstreamModel, requestIds: [...requestIds] }
    };
  }

  private async requestGeneration(body: {
    model: string;
    prompt: string;
    size: OpenAiImageSize;
    quality: OpenAiImageQuality;
    n: number;
    output_format: "png";
  }): Promise<OpenAiImageResponse> {
    let attempt = 0;
    while (true) {
      try {
        return await this.performRequest(body);
      } catch (error) {
        const providerError = normalizeProviderError(error, this.name);
        if (!providerError.retryable || attempt >= this.maxRetries) {
          throw providerError;
        }
        attempt += 1;
        await sleep(this.initialBackoffMs * 2 ** (attempt - 1));
      }
    }
  }

  private async performRequest(body: {
    model: string;
    prompt: string;
    size: OpenAiImageSize;
    quality: OpenAiImageQuality;
    n: number;
    output_format: "png";
  }): Promise<OpenAiImageResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/images/generations`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError("PROVIDER_TIMEOUT", "OpenAI 图片生成超时，请稍后重试。", {
          retryable: true,
          provider: this.name
        });
      }
      throw new ProviderError("PROVIDER_FAILED", "连接 OpenAI 失败，请稍后重试。", {
        retryable: true,
        provider: this.name,
        details: error
      });
    }

    const payload = (await response.json().catch(() => ({}))) as OpenAiImageResponse;
    if (!response.ok) {
      throw mapOpenAiError(response.status, payload, this.name);
    }

    if (!Array.isArray(payload.data)) {
      throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI 返回格式异常。", {
        retryable: false,
        provider: this.name,
        statusCode: response.status,
        details: payload
      });
    }

    return payload;
  }
}

export function resolveDefaultImageProvider(): SupportedProviderName {
  const configuredProvider = firstNonEmptyEnv("IMAGE_PROVIDER_DEFAULT", "AI_PROVIDER");
  if (configuredProvider) {
    return normalizeProviderName(configuredProvider);
  }
  return hasConfiguredOpenAiApiKey() ? "openai" : "mock";
}

export function resolveDefaultImageModel(providerName = resolveDefaultImageProvider()): SupportedImageModel {
  const provider = normalizeProviderName(providerName);
  const configuredModel = process.env.IMAGE_MODEL_DEFAULT?.trim();
  if (configuredModel) {
    const resolvedModel = normalizeModelId(configuredModel);
    const config = providerModelConfigs[resolvedModel];
    if (config.provider !== provider) {
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
  return providerModelConfigs[normalizeModelId(modelId)];
}

export function createImageGenerationProvider(name = resolveDefaultImageProvider()): ImageGenerationProvider {
  switch (normalizeProviderName(name)) {
    case "mock":
      return new MockImageGenerationProvider();
    case "openai":
      return new OpenAiImageGenerationProvider();
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
  return SUPPORTED_IMAGE_MODELS.filter((model) => !provider || providerModelConfigs[model].provider === provider);
}

export function resolveProviderModel(
  inputModel?: ModelId,
  providerName = resolveDefaultImageProvider()
): SupportedImageModel {
  const provider = normalizeProviderName(providerName);
  const requestedModel = inputModel ? normalizeModelId(inputModel) : resolveDefaultImageModel(provider);

  const config = providerModelConfigs[requestedModel];
  if (!config || config.provider !== provider) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      `Provider "${provider}" does not support model "${requestedModel}".`,
      {
        retryable: false,
        provider
      }
    );
  }

  return requestedModel;
}

export function quoteImageGeneration(input: QuoteImageGenerationInput): ImageGenerationQuote {
  const provider = normalizeProviderName(input.provider ?? resolveDefaultImageProvider());
  const model = resolveProviderModel(input.model, provider);
  const config = providerModelConfigs[model];
  const dimension = aspectRatioDimensions[input.aspectRatio];
  const size = openAiSize(dimension.width, dimension.height);
  const quality = openAiQuality(input.quality);
  const modelUnitCost =
    config.quantityMultiplier * config.qualityMultiplier[input.quality] * config.sizeMultiplier[size];
  // 供应商成本随质量/尺寸缩放，与计费口径一致，便于后续毛利核算
  const providerCostPerImage =
    config.costCentsPerImage * config.qualityMultiplier[input.quality] * config.sizeMultiplier[size];
  return {
    provider,
    model,
    creditCost: Math.ceil(modelUnitCost * input.quantity),
    providerCostCents: Math.round(providerCostPerImage * input.quantity),
    width: dimension.width,
    height: dimension.height,
    size,
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

function hasConfiguredOpenAiApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function normalizeModelId(modelId: ModelId): SupportedImageModel {
  const normalized = modelId.trim();
  const resolved = modelAliases[normalized];
  if (resolved) {
    return resolved;
  }
  throw new Error(`Unsupported image model: ${modelId}`);
}

function resolveConfiguredOpenAiModel(): SupportedImageModel {
  const value = process.env.OPENAI_IMAGE_MODEL?.trim();
  if (!value) {
    return DEFAULT_OPENAI_MODEL_ID;
  }
  const modelId = normalizeModelId(value);
  if (providerModelConfigs[modelId].provider !== "openai") {
    throw new Error(`Unsupported OPENAI_IMAGE_MODEL: ${value}`);
  }
  return modelId;
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

function extractOpenAiImageBytes(item: OpenAiImageItem | undefined, payload: OpenAiImageResponse): string {
  const bytes = item?.b64_json?.trim();
  if (bytes) {
    return bytes;
  }

  if (typeof item?.url === "string" && item.url.trim()) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "OpenAI GPT 图像模型必须返回 b64_json，不能返回 url。", {
      retryable: false,
      provider: "openai",
      details: { payload, item }
    });
  }

  throw new ProviderError("PROVIDER_EMPTY_RESULT", "OpenAI 未返回图片数据。", {
    retryable: false,
    provider: "openai",
    details: payload
  });
}

function mapOpenAiError(status: number, payload: OpenAiImageResponse, provider: SupportedProviderName): ProviderError {
  const message = payload.error?.message ?? `OpenAI returned ${status}`;
  const code = payload.error?.code?.toLowerCase() ?? "";
  const type = payload.error?.type?.toLowerCase() ?? "";
  const statusCode = status;

  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_AUTH_FAILED", message, {
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

function buildPrompt(input: GenerateImageInput): string {
  const parts = [
    input.prompt,
    `Style: ${input.style.replace(/_/g, " ")}`,
    `Aspect ratio: ${input.aspectRatio}`,
    input.negativePrompt ? `Avoid: ${input.negativePrompt}` : null,
    input.referenceImageUrl ? `Reference image URL: ${input.referenceImageUrl}` : null
  ];
  return parts.filter(Boolean).join("\n");
}

function openAiSize(width: number, height: number): OpenAiImageSize {
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envNumber(name: string, fallback: number, allowZero = false): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : fallback;
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

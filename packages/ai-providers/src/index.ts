import type { AspectRatio, Quality, StyleId } from "@imagora/shared";

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
  name: string;
  modelName: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

export class MockImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "mock";
  readonly modelName = "imagora-mock-v1";

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (/\bfail\b/i.test(input.prompt)) {
      throw new Error("生成服务返回失败，请调整提示词后重试。");
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
  readonly modelName = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
  private readonly apiKey = requiredEnv("OPENAI_API_KEY");
  private readonly baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  private readonly timeoutMs = envNumber("OPENAI_TIMEOUT_MS", 120_000);

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.modelName,
        prompt: buildPrompt(input),
        n: input.quantity,
        size: openAiSize(input.width, input.height),
        quality: openAiQuality(input.quality),
        response_format: "b64_json"
      })
    });
    const payload = (await response.json().catch(() => ({}))) as OpenAiImageResponse;
    if (!response.ok) {
      const message = payload.error?.message ?? `OpenAI image generation failed with ${response.status}`;
      throw new Error(message);
    }
    const images = payload.data ?? [];
    if (!images.length) {
      throw new Error("OpenAI image generation returned no images");
    }
    return {
      providerRequestId: payload.id ?? `openai_${input.taskId}`,
      images: images.map((image, index) => {
        if (!image.b64_json) {
          throw new Error("OpenAI image response did not include b64_json");
        }
        return {
          bytes: image.b64_json,
          mimeType: "image/png",
          width: input.width,
          height: input.height,
          index
        };
      }),
      raw: { provider: this.name, model: this.modelName }
    };
  }
}

/**
 * Stability AI Provider (Stable Diffusion) - 骨架占位
 *
 * 使用前需要配置环境变量：
 * - STABILITY_API_KEY: Stability AI API 密钥
 * - STABILITY_ENGINE: 引擎版本（默认 stable-diffusion-xl-1024-v1-0）
 * - STABILITY_BASE_URL: API 地址（默认 https://api.stability.ai）
 */
export class StabilityAiProvider implements ImageGenerationProvider {
  readonly name = "stability";
  readonly modelName = process.env.STABILITY_ENGINE ?? "stable-diffusion-xl-1024-v1-0";
  private readonly apiKey = requiredEnv("STABILITY_API_KEY");
  private readonly baseUrl = process.env.STABILITY_BASE_URL ?? "https://api.stability.ai";
  private readonly timeoutMs = envNumber("STABILITY_TIMEOUT_MS", 120_000);

  async generateImage(_input: GenerateImageInput): Promise<GenerateImageResult> {
    // TODO: 实现 Stability AI 图片生成
    // 参考文档: https://platform.stability.ai/docs/api-reference
    throw new Error(
      "StabilityAiProvider not implemented yet. Install SDK and implement image generation:\n" +
        `  API: ${this.baseUrl}, Engine: ${this.modelName}, Timeout: ${this.timeoutMs}ms\n` +
        "  Reference: https://platform.stability.ai/docs/api-reference#tag/v1generation"
    );
  }
}

/**
 * Midjourney Provider (通过第三方 API) - 骨架占位
 *
 * 使用前需要配置环境变量：
 * - MIDJOURNEY_API_KEY: Midjourney API 密钥
 * - MIDJOURNEY_BASE_URL: 第三方 API 地址（如 https://api.midjourney.com）
 * - MIDJOURNEY_TIMEOUT_MS: 超时时间（默认 300000ms / 5分钟）
 *
 * 注意：Midjourney 官方没有直接 API，需要使用第三方服务或 Discord Bot
 */
export class MidjourneyProvider implements ImageGenerationProvider {
  readonly name = "midjourney";
  readonly modelName = "midjourney-v6";
  private readonly apiKey = requiredEnv("MIDJOURNEY_API_KEY");
  private readonly baseUrl = requiredEnv("MIDJOURNEY_BASE_URL");
  private readonly timeoutMs = envNumber("MIDJOURNEY_TIMEOUT_MS", 300_000);

  async generateImage(_input: GenerateImageInput): Promise<GenerateImageResult> {
    // TODO: 实现 Midjourney 图片生成
    // Midjourney 生成通常需要轮询，因为生成时间较长
    throw new Error(
      "MidjourneyProvider not implemented yet. Implement via third-party API:\n" +
        `  API: ${this.baseUrl}, Timeout: ${this.timeoutMs}ms\n` +
        "  Note: Midjourney requires polling for completion. Consider using a queue-based approach."
    );
  }
}

/**
 * 阿里云通义万相 Provider - 骨架占位
 *
 * 使用前需要配置环境变量：
 * - ALIYUN_ACCESS_KEY_ID: 阿里云 Access Key ID
 * - ALIYUN_ACCESS_KEY_SECRET: 阿里云 Access Key Secret
 * - ALIYUN_WANX_ENDPOINT: 通义万相 API 端点（默认 wanx.cn-beijing.aliyuncs.com）
 * - ALIYUN_WANX_MODEL: 模型版本（默认 wanx-v1）
 */
export class AliyunWanxProvider implements ImageGenerationProvider {
  readonly name = "aliyun-wanx";
  readonly modelName = process.env.ALIYUN_WANX_MODEL ?? "wanx-v1";
  private readonly accessKeyId = requiredEnv("ALIYUN_ACCESS_KEY_ID");
  private readonly accessKeySecret = requiredEnv("ALIYUN_ACCESS_KEY_SECRET");
  private readonly endpoint = process.env.ALIYUN_WANX_ENDPOINT ?? "wanx.cn-beijing.aliyuncs.com";
  private readonly timeoutMs = envNumber("ALIYUN_WANX_TIMEOUT_MS", 120_000);

  async generateImage(_input: GenerateImageInput): Promise<GenerateImageResult> {
    // TODO: 实现阿里云通义万相图片生成
    // 参考文档: https://help.aliyun.com/zh/dashscope/developer-reference/api-details-9
    throw new Error(
      "AliyunWanxProvider not implemented yet. Install @alicloud/wanx SDK:\n" +
        `  Endpoint: ${this.endpoint}, Model: ${this.modelName}, Timeout: ${this.timeoutMs}ms\n` +
        "  Reference: https://help.aliyun.com/zh/dashscope/developer-reference/api-details-9"
    );
  }
}

export function createImageGenerationProvider(name = process.env.AI_PROVIDER ?? "mock"): ImageGenerationProvider {
  switch (name) {
    case "mock":
      return new MockImageGenerationProvider();
    case "openai":
      return new OpenAiImageGenerationProvider();
    case "stability":
      return new StabilityAiProvider();
    case "midjourney":
      return new MidjourneyProvider();
    case "aliyun-wanx":
      return new AliyunWanxProvider();
    default:
      throw new Error(`Unsupported AI provider: ${name}`);
  }
}

interface OpenAiImageResponse {
  id?: string;
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
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

function openAiSize(width: number, height: number): "1024x1024" | "1024x1536" | "1536x1024" {
  if (width === height) {
    return "1024x1024";
  }
  return height > width ? "1024x1536" : "1536x1024";
}

function openAiQuality(quality: Quality): "low" | "medium" | "high" {
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

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

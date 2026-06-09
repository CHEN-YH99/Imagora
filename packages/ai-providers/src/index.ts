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

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
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

export function createImageGenerationProvider(name = process.env.AI_PROVIDER ?? "mock"): ImageGenerationProvider {
  switch (name) {
    case "mock":
      return new MockImageGenerationProvider();
    case "openai":
      return new OpenAiImageGenerationProvider();
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

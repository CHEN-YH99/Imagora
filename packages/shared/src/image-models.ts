import type { Quality } from "./index.js";

export const aspectRatios = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "1:2",
  "2:1",
  "21:9"
] as const;
export type AspectRatio = (typeof aspectRatios)[number];
const aspectRatioLabels: Record<AspectRatio, string> = {
  "1:1": "方形",
  "2:3": "人像",
  "3:2": "横向摄影",
  "3:4": "竖版",
  "4:3": "横版",
  "4:5": "社交竖图",
  "5:4": "横向展示",
  "9:16": "手机竖屏",
  "16:9": "宽屏",
  "1:2": "长竖图",
  "2:1": "横幅",
  "21:9": "超宽屏"
};
export const aspectRatioOptions = aspectRatios.map((value) => ({
  value,
  label: value + " · " + aspectRatioLabels[value]
}));
export const aspectRatioDimensions: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "3:2": { width: 1536, height: 1024 },
  "3:4": { width: 960, height: 1280 },
  "4:3": { width: 1280, height: 960 },
  "4:5": { width: 1024, height: 1280 },
  "5:4": { width: 1280, height: 1024 },
  "9:16": { width: 864, height: 1536 },
  "16:9": { width: 1536, height: 864 },
  "1:2": { width: 768, height: 1536 },
  "2:1": { width: 1536, height: 768 },
  "21:9": { width: 1792, height: 768 }
};

export type ImageApiFormat = "gpt-image" | "openai-images" | "grok-image";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export interface ImageModelChannel {
  name: string;
  upstreamModel?: string;
  costCentsPerImage?: number;
  aspectRatios?: AspectRatio[];
}
export type ImageAspectRatioSource = "documented" | "upstream" | "configured" | "unverified";
export interface ProviderModelConfig {
  provider: "openai" | "mock";
  modelId: string;
  upstreamModel: string;
  label: string;
  enabled: boolean;
  apiFormat: ImageApiFormat;
  channels?: ImageModelChannel[];
  qualities: Quality[];
  aspectRatios: AspectRatio[];
  /** 显式部署限制，不能被自动发现或文档默认值扩大。 */
  aspectRatioAllowlist?: AspectRatio[];
  aspectRatioSource?: ImageAspectRatioSource;
  maxQuantity: number;
  qualityMultiplier: Record<Quality, number>;
  sizeMultiplier: Record<ImageSize, number>;
  quantityMultiplier: number;
  costCentsPerImage: number;
  resolution?: "standard" | "4k";
  creditMultiplier?: 1 | 2;
  group?: string;
  primaryChannel?: string;
}
/** 服务端任务快照；不包含凭据，不通过用户接口返回。 */
export interface ImageGenerationSnapshot {
  version: 1;
  model: ProviderModelConfig;
  channels: Array<{
    name: string;
    baseUrl: string;
    priority: number;
    upstreamModel?: string;
    costCentsPerImage?: number;
    aspectRatios?: AspectRatio[];
  }>;
}

import {
  aspectRatios as supportedAspectRatios,
  type AspectRatio,
  type Quality,
  type ProviderModelConfig,
  type ImageSize,
  type ImageModelChannel
} from "@imagora/shared";
import { resolveAllImageChannels, type ImageChannelConfig } from "./channels.js";

export type { ImageApiFormat, ImageSize, ImageModelChannel, ProviderModelConfig } from "@imagora/shared";

export interface PublicImageModel {
  id: string;
  label: string;
  qualities: Quality[];
  aspectRatios: AspectRatio[];
  aspectRatioSource?: ProviderModelConfig["aspectRatioSource"];
  maxQuantity: number;
  group?: string;
  creditMultiplier?: 1 | 2;
  resolution?: "standard" | "4k";
}

const qualities: Quality[] = ["draft", "standard", "high"];
const aspectRatios: AspectRatio[] = [...supportedAspectRatios];
const imageSizes: ImageSize[] = ["1024x1024", "1024x1536", "1536x1024"];
const modelIdPattern = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._/-]*$/i;

const defaultOpenAiModel: ProviderModelConfig = {
  provider: "openai",
  modelId: "openai:gpt-image-2",
  upstreamModel: "gpt-image-2",
  label: "GPT Image 2",
  enabled: true,
  apiFormat: "gpt-image",
  qualities,
  aspectRatios,
  aspectRatioSource: "configured",
  maxQuantity: 4,
  qualityMultiplier: { draft: 0.75, standard: 1, high: 1.7 },
  sizeMultiplier: { "1024x1024": 1, "1024x1536": 1.22, "1536x1024": 1.22 },
  quantityMultiplier: 7,
  costCentsPerImage: 4
};

const defaultMockModel: ProviderModelConfig = {
  ...defaultOpenAiModel,
  provider: "mock",
  modelId: "mock:default",
  upstreamModel: "mock",
  label: "Imagora Mock",
  aspectRatioSource: "configured",
  qualityMultiplier: { draft: 0.4, standard: 0.65, high: 1 },
  sizeMultiplier: { "1024x1024": 1, "1024x1536": 1.1, "1536x1024": 1.1 },
  quantityMultiplier: 4,
  costCentsPerImage: 0
};

let discoveredRegistry: { fingerprint: string; models: ProviderModelConfig[] } | undefined;

export function modelConfigurationFingerprint(env: Partial<Record<string, string | undefined>> = process.env): string {
  // 动态模型目录属于“当前选中的 API 渠道”。切换渠道后必须让注册表失效，
  // 否则前端仍可能读到上一条 API 的模型列表。
  return JSON.stringify([
    env.IMAGE_MODELS,
    env.IMAGE_CHANNELS,
    env.OPENAI_BASE_URL,
    env.IMAGE_MODEL_DISCOVERY_CHANNEL,
    env.IMAGE_MODEL_DISCOVERY
  ]);
}

export function publishImageModelConfigs(models: ProviderModelConfig[] | undefined): void {
  discoveredRegistry = models
    ? { fingerprint: modelConfigurationFingerprint(), models: structuredClone(models) }
    : undefined;
}

export function readImageModelConfigs(
  env: Partial<Record<string, string | undefined>> = process.env
): ProviderModelConfig[] {
  if (discoveredRegistry?.fingerprint === modelConfigurationFingerprint(env))
    return structuredClone(discoveredRegistry.models);
  return readConfiguredImageModels(env);
}

export function hasDiscoveredImageModels(): boolean {
  return discoveredRegistry?.fingerprint === modelConfigurationFingerprint();
}

export function readConfiguredImageModels(
  env: Partial<Record<string, string | undefined>> = process.env
): ProviderModelConfig[] {
  const raw = env.IMAGE_MODELS?.trim();
  if (!raw) return [defaultOpenAiModel, defaultMockModel];

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("IMAGE_MODELS must be valid JSON");
  }
  if (!Array.isArray(entries)) throw new Error("IMAGE_MODELS must be a JSON array");

  const models = entries.map(normalizeModel);
  const modelIds = new Set<string>();
  const channelNames = new Set(resolveAllImageChannels(env).map((channel) => channel.name));
  for (const model of models) {
    if (modelIds.has(model.modelId)) throw new Error("IMAGE_MODELS contains a duplicate model id");
    modelIds.add(model.modelId);
    for (const channel of model.channels ?? []) {
      if (!channelNames.has(channel.name)) {
        throw new Error(`IMAGE_MODELS model "${model.modelId}" references an unknown channel`);
      }
    }
  }
  return [...models, defaultMockModel];
}

export function resolveModelChannels(model: ProviderModelConfig, channels: ImageChannelConfig[]): ImageChannelConfig[] {
  if (!model.enabled || model.provider === "mock") return [];
  const enabled = channels.filter((channel) => channel.enabled);
  if (!model.channels) return enabled;

  const ordered = model.primaryChannel
    ? [...enabled].sort((a, b) => Number(b.name === model.primaryChannel) - Number(a.name === model.primaryChannel))
    : enabled;
  return ordered.flatMap((channel) => {
    const binding = model.channels?.find((entry) => entry.name === channel.name);
    if (!binding) return [];
    return [
      {
        ...channel,
        upstreamModel: binding.upstreamModel ?? model.upstreamModel,
        costCentsPerImage: binding.costCentsPerImage ?? model.costCentsPerImage,
        aspectRatios: binding.aspectRatios ?? model.aspectRatios
      }
    ];
  });
}

export function publicImageModel(model: ProviderModelConfig): PublicImageModel {
  return {
    id: model.modelId,
    label: model.label,
    qualities: [...model.qualities],
    aspectRatios: [...model.aspectRatios],
    ...(model.aspectRatioSource ? { aspectRatioSource: model.aspectRatioSource } : {}),
    maxQuantity: model.maxQuantity,
    ...(model.group ? { group: model.group } : {}),
    ...(model.creditMultiplier ? { creditMultiplier: model.creditMultiplier } : {}),
    ...(model.resolution ? { resolution: model.resolution } : {})
  };
}

function normalizeModel(value: unknown, index: number): ProviderModelConfig {
  const prefix = `IMAGE_MODELS[${index}]`;
  const entry = readObject(value, prefix);
  const modelId = readText(entry.id, prefix + ".id", 80);
  if (!modelIdPattern.test(modelId) || modelId.toLowerCase().startsWith("mock:")) {
    throw new Error(prefix + ".id must be a namespaced image model id and cannot use mock:");
  }
  const label = readText(entry.label, prefix + ".label", 80);
  const upstreamModel = readText(entry.upstreamModel, prefix + ".upstreamModel", 160);
  const apiFormat = entry.apiFormat;
  if (apiFormat !== "gpt-image" && apiFormat !== "openai-images" && apiFormat !== "grok-image") {
    throw new Error(prefix + ".apiFormat must be gpt-image, openai-images or grok-image");
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
    throw new Error(prefix + ".enabled must be a boolean");
  }
  if (!Array.isArray(entry.channels) || !entry.channels.length) {
    throw new Error(prefix + ".channels must contain at least one channel binding");
  }
  const channelNames = new Set<string>();
  const channels = entry.channels.map((value, channelIndex): ImageModelChannel => {
    const bindingPrefix = `${prefix}.channels[${channelIndex}]`;
    const binding = typeof value === "string" ? { name: value } : readObject(value, bindingPrefix);
    const name = readText(binding.name, bindingPrefix + ".name", 64);
    if (channelNames.has(name)) throw new Error(prefix + ".channels contains a duplicate binding");
    channelNames.add(name);
    if (binding.aspectRatios !== undefined)
      readOptions(binding.aspectRatios, aspectRatios, bindingPrefix + ".aspectRatios");
    return {
      name,
      aspectRatios: [...aspectRatios],
      ...(binding.upstreamModel === undefined
        ? {}
        : {
            upstreamModel: readText(binding.upstreamModel, bindingPrefix + ".upstreamModel", 160)
          }),
      ...(binding.costCentsPerImage === undefined
        ? {}
        : {
            costCentsPerImage: readNumber(binding.costCentsPerImage, bindingPrefix + ".costCentsPerImage", true)
          })
    };
  });
  const supportedQualities = apiFormat === "gpt-image" ? qualities : ["standard" as const];
  const allowedQualities = readOptions(entry.qualities, supportedQualities, prefix + ".qualities");
  if (entry.aspectRatios !== undefined) readOptions(entry.aspectRatios, aspectRatios, prefix + ".aspectRatios");
  const ratioCapabilities = resolveImageAspectRatios();
  const maxQuantity = entry.maxQuantity === undefined ? 4 : readNumber(entry.maxQuantity, prefix + ".maxQuantity");
  if (!Number.isInteger(maxQuantity) || maxQuantity > 4) throw new Error(prefix + ".maxQuantity must be 1 to 4");
  return {
    provider: "openai",
    modelId,
    label,
    upstreamModel,
    enabled: entry.enabled !== false,
    apiFormat,
    ...(isGpt4kModel(upstreamModel) ? { resolution: "4k" as const, creditMultiplier: 2 as const } : {}),
    channels,
    qualities: allowedQualities,
    ...ratioCapabilities,
    maxQuantity,
    quantityMultiplier: readNumber(entry.creditsPerImage, prefix + ".creditsPerImage"),
    costCentsPerImage: readNumber(entry.costCentsPerImage, prefix + ".costCentsPerImage", true),
    qualityMultiplier: readMultipliers(
      entry.qualityMultiplier,
      apiFormat === "gpt-image" ? defaultOpenAiModel.qualityMultiplier : { draft: 1, standard: 1, high: 1 },
      qualities,
      prefix + ".qualityMultiplier"
    ),
    sizeMultiplier: readMultipliers(
      entry.sizeMultiplier,
      apiFormat === "gpt-image"
        ? defaultOpenAiModel.sizeMultiplier
        : { "1024x1024": 1, "1024x1536": 1, "1536x1024": 1 },
      imageSizes,
      prefix + ".sizeMultiplier"
    )
  };
}

function readObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(name + " must be an object");
  return value as Record<string, unknown>;
}

function readText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength ||
    /[\r\n]/.test(value) ||
    value.includes(String.fromCharCode(0))
  ) {
    throw new Error(name + " must be a non-empty, single-line string within the length limit");
  }
  return value.trim();
}

function readNumber(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(name + " must be a finite " + (allowZero ? "non-negative" : "positive") + " number");
  }
  return value;
}

function readOptions<Value extends string>(value: unknown, allowed: Value[], name: string): Value[] {
  if (value === undefined) return [...allowed];
  if (!Array.isArray(value) || !value.length || value.some((option) => !allowed.includes(option as Value))) {
    throw new Error(name + " must be a non-empty list of supported options");
  }
  if (new Set(value).size !== value.length) throw new Error(name + " must not contain duplicates");
  return value as Value[];
}

function readMultipliers<Key extends string>(
  value: unknown,
  defaults: Record<Key, number>,
  keys: Key[],
  name: string
): Record<Key, number> {
  if (value === undefined) return { ...defaults };
  const record = readObject(value, name);
  if (Object.keys(record).some((key) => !keys.includes(key as Key)))
    throw new Error(name + " contains an unknown option");
  const result = { ...defaults };
  for (const key of keys) {
    if (record[key] !== undefined) result[key] = readNumber(record[key], name + "." + key);
  }
  return result;
}

/** 2026-10-01 产品确认：所有生图模型统一支持界面列出的全部预设比例。 */
export function resolveImageAspectRatios(): Pick<ProviderModelConfig, "aspectRatios" | "aspectRatioSource"> {
  return { aspectRatios: [...aspectRatios], aspectRatioSource: "configured" };
}

export function isGpt4kModel(upstreamModel: string): boolean {
  return /^gpt[-_ ]image(?:[-_ ][a-z0-9.]+)*[-_ ]4k$/i.test(upstreamModel);
}

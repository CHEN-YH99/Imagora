import { type AspectRatio, type Quality } from "@imagora/shared";
import { resolveAllImageChannels, type ImageChannelConfig } from "./channels.js";

export type ImageApiFormat = "gpt-image" | "openai-images" | "grok-image";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface ImageModelChannel {
  name: string;
  upstreamModel?: string;
  costCentsPerImage?: number;
}

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
  maxQuantity: number;
  qualityMultiplier: Record<Quality, number>;
  sizeMultiplier: Record<ImageSize, number>;
  quantityMultiplier: number;
  costCentsPerImage: number;
}

export interface PublicImageModel {
  id: string;
  label: string;
  qualities: Quality[];
  aspectRatios: AspectRatio[];
  maxQuantity: number;
}

const qualities: Quality[] = ["draft", "standard", "high"];
const aspectRatios: AspectRatio[] = ["1:1", "3:4", "4:3", "9:16", "16:9"];
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
  qualityMultiplier: { draft: 0.4, standard: 0.65, high: 1 },
  sizeMultiplier: { "1024x1024": 1, "1024x1536": 1.1, "1536x1024": 1.1 },
  quantityMultiplier: 4,
  costCentsPerImage: 0
};

export function readImageModelConfigs(
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

  return enabled.flatMap((channel) => {
    const binding = model.channels?.find((entry) => entry.name === channel.name);
    if (!binding) return [];
    return [
      {
        ...channel,
        upstreamModel: binding.upstreamModel ?? model.upstreamModel,
        costCentsPerImage: binding.costCentsPerImage ?? model.costCentsPerImage
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
    maxQuantity: model.maxQuantity
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
    return {
      name,
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
  const allowedRatios = readOptions(entry.aspectRatios, aspectRatios, prefix + ".aspectRatios");
  const maxQuantity = entry.maxQuantity === undefined ? 4 : readNumber(entry.maxQuantity, prefix + ".maxQuantity");
  if (!Number.isInteger(maxQuantity) || maxQuantity > 4) throw new Error(prefix + ".maxQuantity must be 1 to 4");
  return {
    provider: "openai",
    modelId,
    label,
    upstreamModel,
    enabled: entry.enabled !== false,
    apiFormat,
    channels,
    qualities: allowedQualities,
    aspectRatios: allowedRatios,
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

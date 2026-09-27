import type { AspectRatio } from "@imagora/shared";

export interface ImageChannelConfig {
  /** 渠道标识，用于日志、熔断键、成本归因；同一池内唯一 */
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 该站实际使用的上游模型名，缺省沿用模型配置里的 upstreamModel */
  upstreamModel?: string;
  /** 数值越小越优先，同值按声明顺序 */
  priority: number;
  enabled: boolean;
  /**
   * 该渠道每张图的真实成本（分）。各中转站定价不同，命中哪个渠道就按哪个渠道记账，
   * 否则 providerCostCents 记的是假账，毛利报表会骗人。
   */
  costCentsPerImage?: number;
  /** 同型号绑定在该线路上可用的比例，供故障切换筛选。 */
  aspectRatios?: AspectRatio[];
}

const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 读取渠道池。优先 IMAGE_CHANNELS（JSON 数组），未配置时回落到单渠道的
 * OPENAI_API_KEY / OPENAI_BASE_URL，保证既有部署零改动升级。
 */
export function resolveImageChannels(
  env: Partial<Record<string, string | undefined>> = process.env
): ImageChannelConfig[] {
  const configured = env.IMAGE_CHANNELS?.trim();
  const channels = configured ? parseImageChannels(configured, env) : legacySingleChannel(env);
  const enabled = channels.filter((channel) => channel.enabled);
  return sortChannelsByPriority(enabled);
}

/** 含被禁用渠道的完整池，用于配置校验与运维查看 */
export function resolveAllImageChannels(
  env: Partial<Record<string, string | undefined>> = process.env
): ImageChannelConfig[] {
  const configured = env.IMAGE_CHANNELS?.trim();
  return sortChannelsByPriority(configured ? parseImageChannels(configured, env) : legacySingleChannel(env));
}

export function hasConfiguredImageChannel(env: Partial<Record<string, string | undefined>> = process.env): boolean {
  try {
    return resolveImageChannels(env).length > 0;
  } catch {
    return false;
  }
}

export function parseImageChannels(
  raw: string,
  env: Partial<Record<string, string | undefined>> = process.env
): ImageChannelConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`IMAGE_CHANNELS must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("IMAGE_CHANNELS must be a JSON array of channel objects");
  }

  const names = new Set<string>();
  return parsed.map((entry, index) => {
    const channel = normalizeChannelEntry(entry, index, env);
    const key = channel.name.toLowerCase();
    if (names.has(key)) {
      throw new Error(`IMAGE_CHANNELS[${index}]: duplicate channel name "${channel.name}"`);
    }
    names.add(key);
    return channel;
  });
}

function normalizeChannelEntry(
  entry: unknown,
  index: number,
  env: Partial<Record<string, string | undefined>>
): ImageChannelConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`IMAGE_CHANNELS[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;

  const name = readString(record.name);
  if (!name) {
    throw new Error(`IMAGE_CHANNELS[${index}]: name is required`);
  }
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    throw new Error(
      `IMAGE_CHANNELS[${index}]: name "${name}" must be 1-64 chars of letters, digits, dot, dash or underscore`
    );
  }

  const inlineKey = readString(record.apiKey) ?? readString(record.api_key);
  const apiKeyEnv = readString(record.apiKeyEnv) ?? readString(record.api_key_env);
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`IMAGE_CHANNELS[${index}]: apiKeyEnv must be an environment variable name`);
  }
  if (apiKeyEnv && inlineKey) {
    throw new Error(`IMAGE_CHANNELS[${index}]: use either apiKey or apiKeyEnv, not both`);
  }
  const apiKey = apiKeyEnv ? readString(env[apiKeyEnv]) : inlineKey;
  if (!apiKey) {
    throw new Error(`IMAGE_CHANNELS[${index}] (${name}): apiKey is required`);
  }

  const baseUrl = normalizeBaseUrl(readString(record.baseUrl) ?? readString(record.base_url), index, name);
  const upstreamModel = readString(record.upstreamModel) ?? readString(record.upstream_model);
  const costCentsPerImage = readOptionalNonNegativeNumber(
    record.costCentsPerImage ?? record.cost_cents_per_image,
    index,
    name
  );

  return {
    name,
    baseUrl,
    apiKey,
    ...(upstreamModel ? { upstreamModel } : {}),
    priority: readOptionalPriority(record.priority, index, name) ?? index,
    enabled: record.enabled === undefined ? true : readBoolean(record.enabled, index, name),
    ...(costCentsPerImage === undefined ? {} : { costCentsPerImage })
  };
}

function legacySingleChannel(env: Partial<Record<string, string | undefined>>): ImageChannelConfig[] {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }
  return [
    {
      name: "default",
      baseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL?.trim(), 0, "default"),
      apiKey,
      priority: 0,
      enabled: true
    }
  ];
}

function sortChannelsByPriority(channels: ImageChannelConfig[]): ImageChannelConfig[] {
  // 稳定排序：优先级相同则保留声明顺序，运维改优先级时行为可预测。
  return channels
    .map((channel, index) => ({ channel, index }))
    .sort((left, right) => left.channel.priority - right.channel.priority || left.index - right.index)
    .map(({ channel }) => channel);
}

function normalizeBaseUrl(value: string | undefined, index: number, name: string): string {
  const raw = value?.trim() || "https://api.openai.com/v1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`IMAGE_CHANNELS[${index}] (${name}): baseUrl "${raw}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && !isLocalHttpUrl(url)) {
    throw new Error(`IMAGE_CHANNELS[${index}] (${name}): baseUrl must use https (http allowed only for localhost)`);
  }
  return raw.replace(/\/$/, "");
}

function isLocalHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function readBoolean(value: unknown, index: number, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  throw new Error(`IMAGE_CHANNELS[${index}] (${name}): enabled must be a boolean`);
}

function readOptionalPriority(value: unknown, index: number, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`IMAGE_CHANNELS[${index}] (${name}): priority must be a number`);
  }
  return parsed;
}

function readOptionalNonNegativeNumber(value: unknown, index: number, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`IMAGE_CHANNELS[${index}] (${name}): costCentsPerImage must be a non-negative number`);
  }
  return parsed;
}

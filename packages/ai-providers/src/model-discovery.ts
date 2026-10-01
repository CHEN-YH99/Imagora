import { aspectRatios, type AspectRatio, type ImageGenerationSnapshot } from "@imagora/shared";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveImageChannels, type ImageChannelConfig } from "./channels.js";
import {
  isGpt4kModel,
  publicImageModel,
  resolveModelChannels,
  publishImageModelConfigs,
  readConfiguredImageModels,
  resolveImageAspectRatios,
  type ProviderModelConfig
} from "./models.js";

type ModelEntry = { id: string; supported_endpoint_types?: string[]; supported_aspect_ratios?: AspectRatio[] };
type ChannelCatalog = { fingerprint: string; models: ModelEntry[]; updatedAt: string };
export interface ImageModelDiscoveryStatus {
  enabled: boolean;
  primaryChannel: string | null;
  refreshing: boolean;
  updatedAt: string | null;
  channels: Array<{ name: string; updatedAt: string | null; error: string | null }>;
}

function fingerprint(channel: ImageChannelConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([channel.name, channel.baseUrl, channel.apiKey]))
    .digest("hex");
}

function family(id: string): string {
  if (/^gpt[-_ ]image/i.test(id)) return "GPT Image";
  if (/(?:nano[-_ ]?banana|banana|gemini[-_ ].*image)/i.test(id)) return "Nano Banana";
  if (/^grok(?:[-_ ].*)?(?:image|imagine)/i.test(id)) return "Grok";
  return "其他";
}

function isImageModel(entry: ModelEntry): boolean {
  if (entry.supported_endpoint_types) return entry.supported_endpoint_types.includes("image-generation");
  // 没有能力元数据时，只接受名称明确指向图像生成的型号；不能把通用聊天模型混入。
  return (
    family(entry.id) !== "其他" ||
    /(?:image|imagine|banana|dall-e|flux|ideogram|stable[-_ ]diffusion|sdxl)/i.test(entry.id)
  );
}

export function parseImageModelDirectory(payload: unknown): ModelEntry[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("模型目录不是有效的 JSON data 数组");
  }
  const result = new Map<string, ModelEntry>();
  for (const value of (payload as { data: unknown[] }).data) {
    if (!value || typeof value !== "object") throw new Error("模型目录包含无效条目");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      entry.id.length > 160 ||
      /[\r\n]/.test(entry.id) ||
      entry.id.includes(String.fromCharCode(0))
    ) {
      throw new Error("模型目录包含无效型号");
    }
    if (
      entry.supported_endpoint_types !== undefined &&
      (!Array.isArray(entry.supported_endpoint_types) ||
        entry.supported_endpoint_types.some((x) => typeof x !== "string"))
    ) {
      throw new Error("模型目录包含无效能力信息");
    }
    const declaredRatios = entry.supported_aspect_ratios ?? entry.aspect_ratios;
    if (
      declaredRatios !== undefined &&
      (!Array.isArray(declaredRatios) || declaredRatios.some((ratio) => typeof ratio !== "string"))
    ) {
      throw new Error("模型目录包含无效比例信息");
    }
    const model: ModelEntry = {
      id: entry.id,
      ...(declaredRatios === undefined
        ? {}
        : {
            supported_aspect_ratios: aspectRatios.filter((ratio) => (declaredRatios as string[]).includes(ratio))
          }),
      ...(entry.supported_endpoint_types
        ? { supported_endpoint_types: entry.supported_endpoint_types as string[] }
        : {})
    };
    if (isImageModel(model)) result.set(model.id, model);
  }
  return [...result.values()];
}

function internalId(id: string): string {
  if (/^gpt-image-[a-z0-9.-]+$/i.test(id)) return "openai:" + id;
  if (/^grok-imagine-image[a-z0-9.-]*$/i.test(id)) return "xai:" + id;
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "model";
  return "image:" + slug + "-" + createHash("sha256").update(id).digest("hex").slice(0, 10);
}

export function buildDiscoveredImageModels(
  primary: ImageChannelConfig,
  directories: Map<string, ModelEntry[]>,
  configured: ProviderModelConfig[],
  channels: ImageChannelConfig[]
): ProviderModelConfig[] {
  const base =
    configured.find((x) => x.apiFormat === "gpt-image" && !isGpt4kModel(x.upstreamModel)) ??
    readConfiguredImageModels({})[0];
  const grokBase = configured.find((x) => x.apiFormat === "grok-image") ?? base;
  const result = (directories.get(primary.name) ?? []).map((entry): ProviderModelConfig => {
    const override = configured.find((model) => {
      const binding = model.channels?.find((entry) => entry.name === primary.name);
      return (
        model.provider === "openai" &&
        (!model.channels || binding) &&
        (binding?.upstreamModel ?? model.upstreamModel) === entry.id
      );
    });
    const group = family(override?.upstreamModel ?? entry.id);
    const fourK = isGpt4kModel(override?.upstreamModel ?? entry.id);
    const template = override ?? (group === "Grok" ? grokBase : base);
    const apiFormat =
      override?.apiFormat ?? (group === "GPT Image" ? "gpt-image" : group === "Grok" ? "grok-image" : "openai-images");
    const ratioCapabilities = resolveImageAspectRatios();
    const bindings = [
      {
        name: primary.name,
        aspectRatios: ratioCapabilities.aspectRatios,
        upstreamModel: entry.id,
        costCentsPerImage:
          override?.channels?.find((x) => x.name === primary.name)?.costCentsPerImage ?? template.costCentsPerImage
      },
      ...channels
        .filter((channel) => channel.name !== primary.name)
        .flatMap((channel) => {
          const explicit = override?.channels?.find((binding) => binding.name === channel.name);
          // 管理员的明确同型号映射，或备用目录中精确相同的型号，才能成为候选线路。
          const target = explicit?.upstreamModel ?? override?.upstreamModel ?? entry.id;
          const directoryEntry = directories.get(channel.name)?.find((model) => model.id === target);
          const capability = resolveImageAspectRatios();
          if (explicit) return [{ ...explicit, upstreamModel: target, aspectRatios: capability.aspectRatios }];
          if (directoryEntry) {
            return [
              {
                name: channel.name,
                upstreamModel: entry.id,
                aspectRatios: capability.aspectRatios,
                costCentsPerImage: channel.costCentsPerImage ?? template.costCentsPerImage
              }
            ];
          }
          return [];
        })
    ];
    return {
      ...structuredClone(template),
      ...ratioCapabilities,
      modelId: override?.modelId ?? internalId(entry.id),
      upstreamModel: entry.id,
      label: override?.label ?? entry.id,
      provider: "openai",
      enabled: override?.enabled ?? true,
      apiFormat,
      channels: bindings,
      qualities: override?.qualities ?? (apiFormat === "gpt-image" ? base.qualities : ["standard"]),
      resolution: fourK ? "4k" : "standard",
      creditMultiplier: fourK ? 2 : 1,
      group,
      primaryChannel: primary.name
    };
  });
  return [...result, ...configured.filter((model) => model.provider === "mock")];
}

export class ImageModelDiscovery {
  private readonly catalogs = new Map<string, ChannelCatalog>();
  private readonly errors = new Map<string, string>();
  private pending?: Promise<ImageModelDiscoveryStatus>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: { cachePath?: string; timeoutMs?: number; fetch?: typeof fetch } = {}) {}

  private configuration() {
    const configured = readConfiguredImageModels();
    const channels = resolveImageChannels();
    const preferred = process.env.IMAGE_MODEL_DISCOVERY_CHANNEL?.trim();
    const gpt = configured.find((x) => x.provider === "openai" && x.apiFormat === "gpt-image" && x.enabled);
    const primary = preferred
      ? channels.find((x) => x.name === preferred)
      : (channels.find((x) => x.name === gpt?.channels?.[0]?.name) ?? channels[0]);
    const provider = process.env.IMAGE_PROVIDER_DEFAULT ?? process.env.AI_PROVIDER;
    const enabled =
      process.env.IMAGE_MODEL_DISCOVERY !== "false" &&
      (process.env.NODE_ENV !== "test" || process.env.IMAGE_MODEL_DISCOVERY === "true") &&
      provider !== "mock" &&
      Boolean(primary);
    return { configured, channels, primary, enabled, provider: provider ?? (channels.length ? "openai" : "mock") };
  }

  status(): ImageModelDiscoveryStatus {
    const { channels, primary, enabled } = this.configuration();
    return {
      enabled,
      primaryChannel: primary?.name ?? null,
      refreshing: Boolean(this.pending),
      updatedAt:
        primary && this.catalogs.get(primary.name)?.fingerprint === fingerprint(primary)
          ? this.catalogs.get(primary.name)!.updatedAt
          : null,
      channels: channels.map((channel) => ({
        name: channel.name,
        updatedAt:
          this.catalogs.get(channel.name)?.fingerprint === fingerprint(channel)
            ? this.catalogs.get(channel.name)!.updatedAt
            : null,
        error: this.errors.get(channel.name) ?? null
      }))
    };
  }

  private channelModels(channelName?: string) {
    const { configured, channels, primary, enabled, provider } = this.configuration();
    if (provider === "mock") {
      if (channelName) throw new Error("当前模式不支持选择 API 线路。");
      return {
        models: configured.filter((model) => model.provider === "mock"),
        channel: null,
        primary,
        channels: [],
        error: null,
        updatedAt: null
      };
    }
    const channel = channelName ? channels.find((entry) => entry.name === channelName) : primary;
    if (!channel) {
      if (channelName) throw new Error("所选 API 线路不存在或已停用。");
      return { models: [], channel: null, primary, channels, error: "暂无可用 API 线路。", updatedAt: null };
    }
    const directories = new Map(
      channels.flatMap((entry) => {
        const saved = this.catalogs.get(entry.name);
        return saved?.fingerprint === fingerprint(entry) ? [[entry.name, saved.models] as const] : [];
      })
    );
    const hasDirectory = directories.has(channel.name);
    const models =
      enabled && hasDirectory
        ? buildDiscoveredImageModels(channel, directories, configured, channels)
        : enabled && channel.name !== primary?.name
          ? []
          : configured.map((model) => ({
              ...model,
              ...(model.provider === "mock" ? {} : resolveImageAspectRatios())
            }));
    const routable = models.filter(
      (model) =>
        model.enabled &&
        model.provider === "openai" &&
        resolveModelChannels(model, channels).some((candidate) => candidate.name === channel.name)
    );
    return {
      models: routable,
      channel,
      primary,
      channels,
      error: enabled
        ? (this.errors.get(channel.name) ?? (!hasDirectory ? "尚未获取到该线路的模型目录。" : null))
        : null,
      updatedAt: hasDirectory ? this.catalogs.get(channel.name)!.updatedAt : null
    };
  }

  /** 每次请求独立选择目录，不修改默认线路或其他用户的目录。 */
  catalog(channelName?: string) {
    const selected = this.channelModels(channelName);
    const preferred = process.env.IMAGE_MODEL_DEFAULT?.trim();
    const defaultModel =
      selected.models.find((model) => model.modelId === preferred)?.modelId ??
      selected.models.find((model) => model.modelId === "openai:gpt-image-2")?.modelId ??
      selected.models[0]?.modelId ??
      null;
    return {
      models: selected.models.map(publicImageModel),
      defaultModel,
      channel: selected.channel?.name ?? null,
      defaultChannel: selected.primary?.name ?? null,
      channels: [...selected.channels]
        .sort((a, b) => Number(b.name === selected.primary?.name) - Number(a.name === selected.primary?.name))
        .map((channel) => ({
          id: channel.name,
          label: channel.name === selected.primary?.name ? "主线路 API" : "备用 API（" + channel.name + "）"
        })),
      updatedAt: selected.updatedAt,
      error: selected.error
    };
  }

  snapshot(channelName: string, modelId?: string): ImageGenerationSnapshot {
    const selected = this.channelModels(channelName);
    const requested = modelId === "gpt-image-2" ? "openai:gpt-image-2" : modelId;
    const model = selected.models.find(
      (entry) => entry.modelId === (requested ?? this.catalog(channelName).defaultModel)
    );
    if (!model || !selected.channel) throw new Error("所选 API 不支持该模型或模型目录暂不可用，请重新选择。");
    const snapshotModel = { ...structuredClone(model), primaryChannel: selected.channel.name };
    const candidates = resolveModelChannels(snapshotModel, selected.channels).filter(
      (entry) => selected.channel!.name === selected.primary?.name || entry.name === selected.channel!.name
    );
    if (!candidates.length) throw new Error("所选 API 线路不可用。");
    return {
      version: 1,
      model: snapshotModel,
      channels: candidates.map(({ name, baseUrl, priority, upstreamModel, costCentsPerImage, aspectRatios }) => ({
        name,
        baseUrl,
        priority,
        upstreamModel,
        costCentsPerImage,
        aspectRatios
      }))
    };
  }

  private publish() {
    const { configured, channels, primary, enabled } = this.configuration();
    if (!enabled || !primary) {
      // 关闭动态发现或切换到无效渠道时，不能继续暴露上一条 API 的模型目录。
      publishImageModelConfigs(undefined);
      return;
    }
    const directories = new Map(
      channels.flatMap((channel) => {
        const cached = this.catalogs.get(channel.name);
        return cached?.fingerprint === fingerprint(channel) ? [[channel.name, cached.models] as const] : [];
      })
    );
    if (directories.has(primary.name)) {
      // 默认注册表只发布主线路目录；显式选线通过 catalog/snapshot 独立解析。
      publishImageModelConfigs(buildDiscoveredImageModels(primary, directories, configured, channels));
    } else {
      // 当前渠道还没有可用目录时，清掉旧渠道快照，避免 API 切换后串出旧模型。
      publishImageModelConfigs(undefined);
    }
  }

  async start(): Promise<void> {
    if (!this.configuration().enabled || this.timer) return;
    if (this.options.cachePath) {
      try {
        const cached: unknown = JSON.parse(await readFile(this.options.cachePath, "utf8"));
        if (cached && typeof cached === "object") {
          for (const [name, value] of Object.entries(cached)) {
            if (!value || typeof value !== "object") continue;
            const record = value as ChannelCatalog;
            if (
              typeof record.fingerprint === "string" &&
              typeof record.updatedAt === "string" &&
              Number.isFinite(Date.parse(record.updatedAt))
            ) {
              this.catalogs.set(name, { ...record, models: parseImageModelDirectory({ data: record.models }) });
            }
          }
        }
        this.publish();
      } catch {
        /* 缓存缺失或损坏时重新同步，不影响静态配置启动。 */
      }
    }
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 10 * 60_000);
    this.timer.unref();
  }

  refresh(): Promise<ImageModelDiscoveryStatus> {
    if (this.pending) return this.pending;
    this.pending = this.synchronize().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async synchronize(): Promise<ImageModelDiscoveryStatus> {
    const { channels, enabled } = this.configuration();
    if (!enabled) {
      this.publish();
      return this.status();
    }
    await Promise.all(
      channels.map(async (channel) => {
        try {
          const response = await (this.options.fetch ?? fetch)(channel.baseUrl + "/models", {
            headers: { Authorization: "Bearer " + channel.apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
            redirect: "error"
          });
          if (!response.ok) throw new Error("模型目录 HTTP " + response.status);
          const text = await response.text();
          if (text.length > 2_000_000) throw new Error("模型目录超过大小限制");
          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error("模型目录返回非 JSON 内容（可能处于维护中）");
          }
          const models = parseImageModelDirectory(payload);
          this.catalogs.set(channel.name, {
            fingerprint: fingerprint(channel),
            models,
            updatedAt: new Date().toISOString()
          });
          this.errors.delete(channel.name);
        } catch (error) {
          // 不记录上游响应正文、URL或凭据；失败保留上一份成功目录。
          const safe =
            error instanceof Error && /^(模型目录|模型目录包含)/.test(error.message)
              ? error.message
              : "模型目录同步失败或超时，保留上次成功结果";
          this.errors.set(channel.name, safe);
        }
      })
    );
    this.publish();
    if (this.options.cachePath && this.catalogs.size) {
      try {
        await mkdir(dirname(this.options.cachePath), { recursive: true });
        const temporary = this.options.cachePath + "." + process.pid + ".tmp";
        await writeFile(temporary, JSON.stringify(Object.fromEntries(this.catalogs)), { mode: 0o600 });
        await rename(temporary, this.options.cachePath);
      } catch {
        this.errors.set(this.configuration().primary!.name, "目录已同步，但持久缓存写入失败");
      }
    }
    return { ...this.status(), refreshing: false };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}

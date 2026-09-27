import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  ImageModelDiscovery,
  OpenAiImageGenerationProvider,
  createChannelHealthStore,
  quoteImageGeneration,
  resolveImageChannels
} from "../../packages/ai-providers/dist/index.js";
import { aspectRatios } from "../../packages/shared/dist/image-models.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [name, ...value] = arg.replace(/^--/, "").split("=");
    return [name, value.join("=") || true];
  })
);
if (args.has("execute") && args.get("execute") !== true) {
  throw new Error("--execute 只接受独立开关，省略该开关即可只预览。");
}
const execute = args.get("execute") === true;
const channelName = args.get("channel");
const modelName = args.get("model");
if (typeof channelName !== "string" || typeof modelName !== "string") {
  throw new Error("使用 --channel=<线路> --model=<型号>；默认只预览，--execute 才调用生图。");
}
const selectedRatios = typeof args.get("ratios") === "string" ? args.get("ratios").split(",") : [...aspectRatios];
if (
  !selectedRatios.length ||
  selectedRatios.some((ratio) => !aspectRatios.includes(ratio)) ||
  new Set(selectedRatios).size !== selectedRatios.length
)
  throw new Error("比例必须来自项目预设且不能重复");
const channel = resolveImageChannels().find((entry) => entry.name === channelName);
if (!channel) throw new Error("线路不存在或未启用");
const discovery = new ImageModelDiscovery();
await discovery.refresh();
const catalog = discovery.catalog(channelName);
const model = catalog.models.find((entry) => entry.id === modelName || entry.label === modelName);
if (!model) throw new Error("该线路没有指定型号");
const snapshot = discovery.snapshot(channelName, model.id);
// 能力探测只在当前进程扩大候选集，不改写服务目录、环境文件或业务积分。
snapshot.model.aspectRatios = [...selectedRatios];
snapshot.channels = snapshot.channels.filter((entry) => entry.name === channelName);
for (const entry of snapshot.channels) entry.aspectRatios = [...selectedRatios];
process.env.OPENAI_MAX_RETRIES = "0";
const requests = selectedRatios.map((aspectRatio) => {
  const input = {
    taskId: "ratio-capability-audit",
    prompt: "A blue ceramic cup on a plain white tabletop, soft daylight, no text.",
    style: "none",
    quality: "standard",
    quantity: 1,
    aspectRatio,
    model: model.id,
    modelSnapshot: snapshot,
    width: 1024,
    height: 1024
  };
  const quote = quoteImageGeneration(input);
  return { ...input, width: quote.width, height: quote.height, requestSize: quote.size };
});
console.log(
  JSON.stringify(
    {
      channel: channelName,
      model: model.label,
      requestCount: requests.length,
      execute,
      requests: requests.map(({ aspectRatio, requestSize }) => ({ aspectRatio, requestSize }))
    },
    null,
    2
  )
);
if (!execute) {
  await discovery.close();
} else {
  const provider = new OpenAiImageGenerationProvider({
    channels: [channel],
    healthStore: createChannelHealthStore({ provider: "memory" }),
    failoverOnTimeout: false
  });
  const report = {
    channel: channelName,
    origin: new URL(channel.baseUrl).origin,
    model: snapshot.model.upstreamModel,
    checkedAt: new Date().toISOString(),
    status: "running",
    results: []
  };
  const reportPath = resolve(".tmp/image-ratio-audit", model.id.replace(/[^a-z0-9._-]/gi, "-") + ".json");
  await mkdir(resolve(".tmp/image-ratio-audit"), { recursive: true });
  try {
    for (const input of requests) {
      const started = Date.now();
      let result;
      try {
        const response = await provider.generateImage(input);
        const metadata = await sharp(Buffer.from(response.images[0].bytes, "base64")).metadata();
        const [w, h] = input.aspectRatio.split(":").map(Number);
        if (!metadata.width || !metadata.height) throw new Error("Image dimensions unavailable");
        const error = Math.abs(metadata.width / metadata.height / (w / h) - 1);
        const meetsResolution = snapshot.model.resolution !== "4k" || Math.max(metadata.width, metadata.height) >= 4096;
        result = {
          aspectRatio: input.aspectRatio,
          requestSize: input.requestSize,
          status: error > 0.02 ? "ratio_mismatch" : meetsResolution ? "supported" : "resolution_mismatch",
          width: metadata.width,
          height: metadata.height
        };
      } catch (error) {
        result = {
          aspectRatio: input.aspectRatio,
          requestSize: input.requestSize,
          status: "unverified",
          error: error.code ?? error.name,
          statusCode: error.statusCode
        };
      }
      result.durationMs = Date.now() - started;
      report.results.push(result);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(result));
      if (result.status === "unverified") {
        report.status = "stopped_after_error";
        report.uncheckedAspectRatios = requests.slice(report.results.length).map((entry) => entry.aspectRatio);
        break;
      }
    }
    if (report.status === "running") report.status = "completed";
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  } finally {
    await provider.close();
    await discovery.close();
  }
  console.log(
    JSON.stringify({
      reportPath,
      supportedAspectRatios: report.results
        .filter((entry) => entry.status === "supported")
        .map((entry) => entry.aspectRatio)
    })
  );
}

import { ImageModelDiscovery } from "@imagora/ai-providers";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
// 与 JsonStore 一致：相对路径以工作区根目录为准，不能随 API 的启动目录变化。
const storePath = resolve(workspaceRoot, process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");
export const imageModelDiscovery = new ImageModelDiscovery({
  cachePath: process.env.IMAGE_MODEL_CATALOG_CACHE_PATH
    ? resolve(workspaceRoot, process.env.IMAGE_MODEL_CATALOG_CACHE_PATH)
    : resolve(dirname(storePath), "image-model-catalog.json")
});

import { copyFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const backupPath = process.argv[2];
if (!backupPath) {
  console.error("Usage: node infra/scripts/restore-json-store.mjs <backup-file>");
  process.exit(1);
}

const source = resolve(backupPath);
const target = resolve(process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");

await stat(source);
await copyFile(source, target);
console.log(`[restore] copied ${source} -> ${target}`);

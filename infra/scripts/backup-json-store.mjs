import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const source = resolve(process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");
const backupDir = resolve(process.env.BACKUP_DIR ?? "backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = resolve(backupDir, `${basename(source, ".json")}-${stamp}.json`);

await stat(source);
await mkdir(backupDir, { recursive: true });
await copyFile(source, target);
console.log(`[backup] copied ${source} -> ${target}`);

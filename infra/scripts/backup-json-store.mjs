import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const source = resolve(process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");
const backupDir = resolve(process.env.BACKUP_DIR ?? "backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = resolve(backupDir, `${basename(source, ".json")}-${stamp}.json`);

const sourceStat = await stat(source);
const sourceContent = await readValidatedJson(source);
await mkdir(backupDir, { recursive: true });
await copyFile(source, target);
const targetContent = await readValidatedJson(target);
const manifest = {
  source,
  target,
  size: sourceStat.size,
  sha256: sha256(sourceContent),
  backupSha256: sha256(targetContent),
  createdAt: new Date().toISOString()
};
if (manifest.sha256 !== manifest.backupSha256) {
  throw new Error("Backup verification failed: sha256 mismatch");
}
const manifestPath = `${target}.manifest.json`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, backup: target, manifest: manifestPath, sha256: manifest.sha256 }, null, 2));

async function readValidatedJson(path) {
  const content = await readFile(path, "utf8");
  JSON.parse(content);
  return content;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

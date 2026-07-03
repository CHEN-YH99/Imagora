import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const backupPath = process.argv[2];
if (!backupPath) {
  console.error("Usage: node infra/scripts/restore-json-store.mjs <backup-file>");
  process.exit(1);
}

const source = resolve(backupPath);
const target = resolve(process.env.IMAGORA_STORE_PATH ?? "data/imagora-store.json");

await stat(source);
const sourceContent = await readValidatedJson(source);
await verifyManifest(source, sourceContent);
await copyFile(source, target);
const targetContent = await readValidatedJson(target);
const sourceHash = sha256(sourceContent);
const targetHash = sha256(targetContent);
if (sourceHash !== targetHash) {
  throw new Error("Restore verification failed: sha256 mismatch");
}
console.log(JSON.stringify({ ok: true, restoredFrom: source, target, sha256: targetHash }, null, 2));

async function verifyManifest(path, content) {
  const manifestPath = `${path}.manifest.json`;
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.sha256 && manifest.sha256 !== sha256(content)) {
    throw new Error("Restore verification failed: manifest sha256 mismatch");
  }
}

async function readValidatedJson(path) {
  const content = await readFile(path, "utf8");
  JSON.parse(content);
  return content;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

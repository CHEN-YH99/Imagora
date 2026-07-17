import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const backupPath = process.argv[2];
if (!backupPath) {
  console.error("Usage: node infra/scripts/restore-postgres.mjs <backup-file>");
  process.exit(1);
}

const databaseUrl = requiredEnv("DATABASE_URL");
const restoreBin = process.env.PG_RESTORE_BIN?.trim() || "pg_restore";
const source = resolve(backupPath);

await stat(source);
const backupContent = await readFile(source);
const backupHash = sha256(backupContent);
await verifyManifest(source, backupHash);

const connection = pgConnection(databaseUrl);
await runCommand(
  restoreBin,
  ["--clean", "--if-exists", "--no-owner", "--no-privileges", ...connection.args, source],
  connection.env
);

console.log(
  JSON.stringify(
    {
      ok: true,
      restoredFrom: source,
      sha256: backupHash,
      database: redactDatabaseUrl(databaseUrl)
    },
    null,
    2
  )
);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function verifyManifest(path, actualSha256) {
  const manifestPath = `${path}.manifest.json`;
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Postgres restore verification failed: manifest missing");
    }
    throw error;
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.sha256 && manifest.sha256 !== actualSha256) {
    throw new Error("Postgres restore verification failed: manifest sha256 mismatch");
  }
}

function pgConnection(value) {
  const url = new URL(value);
  const env = {};
  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
    url.password = "";
  }
  return {
    args: [`--dbname=${url.toString()}`],
    env
  };
}

function redactDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const username = url.username ? decodeURIComponent(url.username) : "";
    const auth = username ? `${username}${url.password ? ":[redacted]" : ""}@` : "";
    return `${url.protocol}//${auth}${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "[redacted-database-url]";
  }
}

function runCommand(command, args, extraEnv) {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      shell,
      windowsHide: true
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const sanitized = sanitizeError(stderr, databaseUrl);
      reject(new Error(`${basename(command)} exited with code ${code}${sanitized ? `: ${sanitized}` : ""}`));
    });
  });
}

function sanitizeError(value, secretSource) {
  if (!value) {
    return "";
  }
  let sanitized = value.replaceAll(secretSource, redactDatabaseUrl(secretSource));
  try {
    const password = new URL(secretSource).password;
    if (password) {
      sanitized = sanitized.replaceAll(decodeURIComponent(password), "[redacted]");
    }
  } catch {
    // ignore invalid URL during error sanitization
  }
  return sanitized.trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

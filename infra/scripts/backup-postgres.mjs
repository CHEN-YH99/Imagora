import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const databaseUrl = requiredEnv("DATABASE_URL");
const backupDir = resolve(process.env.POSTGRES_BACKUP_DIR ?? "backups/postgres");
const dumpBin = process.env.PG_DUMP_BIN?.trim() || "pg_dump";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = resolve(backupDir, `postgres-${safeDatabaseName(databaseUrl)}-${stamp}.dump`);

await mkdir(backupDir, { recursive: true });

const connection = pgConnection(databaseUrl);
await runCommand(
  dumpBin,
  ["--format=custom", "--no-owner", "--no-privileges", `--file=${target}`, ...connection.args],
  connection.env
);

const backupStat = await stat(target);
const backupContent = await readFile(target);
const manifest = {
  database: redactDatabaseUrl(databaseUrl),
  target,
  size: backupStat.size,
  sha256: sha256(backupContent),
  format: "custom",
  createdAt: new Date().toISOString()
};
const manifestPath = `${target}.manifest.json`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      backup: target,
      manifest: manifestPath,
      sha256: manifest.sha256,
      database: manifest.database
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

function safeDatabaseName(value) {
  try {
    const url = new URL(value);
    const name = basename(url.pathname || "postgres") || "postgres";
    return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "postgres";
  } catch {
    return "postgres";
  }
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

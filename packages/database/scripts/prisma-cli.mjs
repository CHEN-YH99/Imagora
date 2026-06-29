import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/prisma-cli.mjs <prisma args...>");
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://imagora:imagora@127.0.0.1:5432/imagora"
};

if (args[0] === "generate-if-needed") {
  if (!needsClientGeneration()) {
    console.log("Prisma Client is up to date");
    process.exit(0);
  }
  process.exit(runPrisma(["generate"]));
}

process.exit(runPrisma(args));

function runPrisma(prismaArgs) {
  const result = spawnSync("prisma", [...prismaArgs, "--schema", "prisma/schema.prisma"], {
    stdio: "inherit",
    shell: true,
    env
  });

  return result.status ?? 1;
}

function needsClientGeneration() {
  const schemaPath = resolve("prisma", "schema.prisma");
  const clientEntryPath = resolve("generated", "client", "index.js");
  const clientTypesPath = resolve("generated", "client", "index.d.ts");
  const clientEnginePath = resolve("generated", "client", "query_engine-windows.dll.node");

  if (!existsSync(clientEntryPath) || !existsSync(clientTypesPath) || !existsSync(clientEnginePath)) {
    return true;
  }

  const schemaMtimeMs = statSync(schemaPath).mtimeMs;
  return [clientEntryPath, clientTypesPath, clientEnginePath].some(
    (filePath) => statSync(filePath).mtimeMs < schemaMtimeMs
  );
}

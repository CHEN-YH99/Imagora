import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/prisma-cli.mjs <prisma args...>");
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://imagora:imagora@127.0.0.1:5432/imagora"
};

const result = spawnSync("prisma", [...args, "--schema", "prisma/schema.prisma"], {
  stdio: "inherit",
  shell: true,
  env
});

process.exit(result.status ?? 1);

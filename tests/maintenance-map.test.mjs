import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("maintenance map generator documents core routes, pages, packages, and env vars", async () => {
  execFileSync("node", ["infra/scripts/generate-maintenance-map.mjs"], {
    cwd: root,
    stdio: "pipe"
  });

  const apiRoutes = await readFile(join(root, "docs/maintenance/generated/api-routes.md"), "utf8");
  const webPages = await readFile(join(root, "docs/maintenance/generated/web-pages.md"), "utf8");
  const packageMap = await readFile(join(root, "docs/maintenance/generated/package-map.md"), "utf8");
  const envVars = await readFile(join(root, "docs/maintenance/generated/env-vars.md"), "utf8");

  assert.match(apiRoutes, /POST `\/api\/generation\/tasks`/);
  assert.match(apiRoutes, /POST `\/api\/auth\/verify-email`/);
  assert.match(webPages, /`\/generate`/);
  assert.match(webPages, /`\/verify-email`/);
  assert.match(packageMap, /@imagora\/database/);
  assert.match(packageMap, /@imagora\/ai-providers/);
  assert.match(envVars, /MAILER_PROVIDER/);
  assert.match(envVars, /OPENAI_BASE_URL/);
});

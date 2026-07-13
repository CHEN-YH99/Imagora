import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("maintenance map and quick verification cover modular api routes", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const maintenanceScript = await readFile(join(root, "infra/scripts/generate-maintenance-map.mjs"), "utf8");

  assert.equal(packageJson.scripts["docs:maintenance"], "node infra/scripts/generate-maintenance-map.mjs");
  assert.equal(
    packageJson.scripts["docs:maintenance:check"],
    "node infra/scripts/generate-maintenance-map.mjs --check"
  );
  assert.match(packageJson.scripts["verify:quick"], /docs:maintenance:check/);
  assert.match(packageJson.scripts["verify:quick"], /apps\/api run typecheck/);
  assert.match(packageJson.scripts["verify:quick"], /apps\/web run typecheck/);
  assert.match(packageJson.scripts["verify:quick"], /tests\\?\/generation-state\.test\.mjs/);
  assert.match(packageJson.scripts["verify:quick"], /tests\\?\/api-route-modules\.test\.mjs/);

  assert.match(maintenanceScript, /process\.argv\.includes\("--check"\)/);
  assert.match(maintenanceScript, /collectApiRouteFiles/);
  assert.match(maintenanceScript, /apps", "api", "src", "routes"/);
  assert.doesNotMatch(maintenanceScript, /const apiMain = join\(repoRoot, "apps", "api", "src", "main\.ts"\)/);
});

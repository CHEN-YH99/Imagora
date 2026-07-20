import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("maintenance map and quick verification cover modular api routes", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const maintenanceScript = await readFile(join(root, "infra/scripts/generate-maintenance-map.mjs"), "utf8");
  const ciWorkflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

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
  assert.match(ciWorkflow, /npm run docs:maintenance:check/);
  assert.match(ciWorkflow, /services:\s+postgres:/);
  assert.match(ciWorkflow, /npm --workspace packages\/database run prisma:migrate-deploy/);
  assert.match(ciWorkflow, /PRISMA_STORE_TEST_DATABASE_URL:/);

  assert.match(maintenanceScript, /process\.argv\.includes\("--check"\)/);
  assert.match(maintenanceScript, /collectApiRouteFiles/);
  assert.match(maintenanceScript, /apps", "api", "src", "routes"/);
  assert.doesNotMatch(maintenanceScript, /const apiMain = join\(repoRoot, "apps", "api", "src", "main\.ts"\)/);
});

test("root typecheck builds shared packages once before application no-emit checks", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const typecheckScript = packageJson.scripts.typecheck;

  assert.match(typecheckScript, /^npm run build:packages && npm --workspace apps\/api run typecheck/);
  assert.match(typecheckScript, /npm --workspace apps\/worker run typecheck/);
  assert.match(typecheckScript, /npm --workspace apps\/web run typecheck$/);
  assert.doesNotMatch(typecheckScript, /packages\/shared run typecheck/);
  assert.doesNotMatch(typecheckScript, /packages\/database run typecheck/);
});

test("root runtime dependencies do not include unused local scaffolding CLIs", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.ok(!packageJson.dependencies?.["uipro-cli"]);
});

test("prettier scripts target repo source paths instead of the workspace root", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.doesNotMatch(packageJson.scripts.format, /prettier --write \.$/);
  assert.doesNotMatch(packageJson.scripts["format:check"], /prettier --check \.$/);
  assert.match(packageJson.scripts.format, /--ignore-unknown/);
  assert.match(packageJson.scripts["format:check"], /--ignore-unknown/);
  for (const sourcePath of ["apps", "packages", "infra", "tests"]) {
    assert.match(packageJson.scripts.format, new RegExp(`${sourcePath}/\\*\\*/`));
    assert.match(packageJson.scripts["format:check"], new RegExp(`${sourcePath}/\\*\\*/`));
  }
});

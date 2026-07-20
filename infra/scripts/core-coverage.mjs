import { spawn } from "node:child_process";

const gates = [
  {
    name: "payments",
    include: "packages/payments/dist/index.js",
    tests: ["tests/core-payments-coverage.test.mjs"],
    lines: 40,
    functions: 50,
    branches: 60
  },
  {
    name: "credits",
    include: "packages/shared/dist/index.js",
    tests: ["tests/credit-expiry.test.mjs"],
    lines: 75,
    functions: 60,
    branches: 75
  },
  {
    name: "authentication",
    include: "apps/api/dist/auth-runtime.js",
    tests: ["tests/core-auth-coverage.test.mjs"],
    lines: 95,
    functions: 100,
    branches: 90
  },
  {
    name: "generation-state-machine",
    include: "apps/web/app/generate/generationState.ts",
    tests: ["tests/core-generation-coverage.test.mjs"],
    lines: 95,
    functions: 100,
    branches: 90,
    importTsx: true
  }
];

for (const gate of gates) {
  process.stdout.write(`\n[core-coverage] ${gate.name}\n`);
  const args = [];
  if (gate.importTsx) {
    args.push("--import", "tsx");
  }
  args.push(
    "--test",
    "--experimental-test-coverage",
    `--test-coverage-include=${gate.include}`,
    `--test-coverage-lines=${gate.lines}`,
    `--test-coverage-functions=${gate.functions}`,
    `--test-coverage-branches=${gate.branches}`,
    ...gate.tests
  );
  const code = await runNode(args);
  if (code !== 0) {
    process.exit(code);
  }
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

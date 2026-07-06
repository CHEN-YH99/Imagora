import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const skipManagedWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 7_500
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "on-first-retry"
  },
  webServer: skipManagedWebServer
    ? undefined
    : {
        command: "node infra/scripts/e2e-web-server.mjs",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000
      }
});

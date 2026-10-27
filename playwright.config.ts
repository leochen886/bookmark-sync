import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});

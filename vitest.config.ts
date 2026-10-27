import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "core/tests/**/*.test.ts",
      "relay/tests/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

import { reviewTestAliases } from "../../packages/review/test-config";

export default defineConfig({
  resolve: { alias: reviewTestAliases },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "*.test.ts"],
    testTimeout: 15_000,
  },
});

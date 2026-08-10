import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60000,
    projects: [
      "apps/*/vitest.config.ts",
      "packages/*/vitest.config.ts",
      {
        extends: true,
        test: {
          name: "root-tests",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          fileParallelism: false
        }
      }
    ]
  }
});

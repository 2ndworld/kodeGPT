import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*/vitest.config.ts",
      "packages/*/vitest.config.ts",
      {
        test: {
          name: "root-tests",
          environment: "node",
          include: ["tests/**/*.test.ts"]
        }
      }
    ]
  }
});

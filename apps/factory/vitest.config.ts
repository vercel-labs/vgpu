import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [".eve/**", "node_modules/**"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10_000,
  },
});

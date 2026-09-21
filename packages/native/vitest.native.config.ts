import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["tests/**/*.native.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

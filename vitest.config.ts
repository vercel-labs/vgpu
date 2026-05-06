import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    setupFiles: ["packages/render/tests/imageSnapshot.ts"],
    poolMatchGlobs: [["{packages/adapter-node/tests/**,packages/render/tests/**}", "forks"]],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@vgpu/core": resolve("packages/core/src/index.ts"),
      "@vgpu/adapter-node": resolve("packages/adapter-node/src/index.ts"),
      "@vgpu/adapter-mock": resolve("packages/adapter-mock/src/index.ts"),
      "@vgpu/wgsl": resolve("packages/wgsl/src/index.ts"),
      "@vgpu/render": resolve("packages/render/src/index.ts"),
    },
  },
});

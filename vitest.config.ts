import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["packages/render/tests/imageSnapshot.ts"],
    poolMatchGlobs: [["{packages/adapter-node/tests/**,packages/render/tests/**,tests/seams/s3-spec-40-77.test.ts}", "forks"]],
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: "@vgpu/wgsl/loader-webpack", replacement: resolve("packages/wgsl/src/loader-webpack/index.ts") },
      { find: "@vgpu/wgsl/loader-vite", replacement: resolve("packages/wgsl/src/loader-vite/index.ts") },
      { find: "@vgpu/wgsl/runtime", replacement: resolve("packages/wgsl/src/runtime/resolveShader.ts") },
      { find: "@vgpu/core", replacement: resolve("packages/core/src/index.ts") },
      { find: "@vgpu/adapter-node", replacement: resolve("packages/adapter-node/src/index.ts") },
      { find: "@vgpu/adapter-mock", replacement: resolve("packages/adapter-mock/src/index.ts") },
      { find: "@vgpu/wgsl", replacement: resolve("packages/wgsl/src/index.ts") },
      { find: "@vgpu/render", replacement: resolve("packages/render/src/index.ts") },
    ],
  },
});

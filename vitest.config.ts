import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { wgslVitePlugin } from "./packages/wgsl/src/loader-vite/index.ts";

export default defineConfig({
  plugins: [wgslVitePlugin()],
  test: {
    include: ["packages/**/*.test.ts", "examples/**/*.test.ts", "apps/docs/**/*.test.ts"],
    poolMatchGlobs: [["{packages/adapter-node/tests/**,packages/render/tests/**}", "forks"]],
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: "vgpu/node", replacement: resolve("packages/vgpu-api/src/node.ts") },
      { find: "vgpu/mock", replacement: resolve("packages/vgpu-api/src/mock.ts") },
      { find: "vgpu/scene", replacement: resolve("packages/vgpu-api/src/scene.ts") },
      { find: "vgpu/core", replacement: resolve("packages/vgpu-api/src/core.ts") },
      { find: "vgpu", replacement: resolve("packages/vgpu-api/src/index.ts") },
      { find: "@vgpu/wgsl/loader-webpack", replacement: resolve("packages/wgsl/src/loader-webpack/index.ts") },
      { find: "@vgpu/wgsl/loader-vite", replacement: resolve("packages/wgsl/src/loader-vite/index.ts") },
      { find: "@vgpu/wgsl/runtime", replacement: resolve("packages/wgsl/src/runtime/resolve-shader.ts") },
      { find: "@vgpu/wgsl/reflect-source", replacement: resolve("packages/wgsl/src/runtime/reflect-source.ts") },
      { find: "@vgpu/core", replacement: resolve("packages/core/src/index.ts") },
      { find: "@vgpu/adapter-node", replacement: resolve("packages/adapter-node/src/index.ts") },
      { find: "@vgpu/adapter-mock", replacement: resolve("packages/adapter-mock/src/index.ts") },
      { find: "@vgpu/wgsl", replacement: resolve("packages/wgsl/src/index.ts") },
      { find: "@vgpu/render/inspect", replacement: resolve("packages/render/src/inspect/index.ts") },
      { find: "@vgpu/render/utils", replacement: resolve("packages/render/src/utils/index.ts") },
      { find: "@vgpu/render/edit", replacement: resolve("packages/render/src/edit/index.ts") },
      { find: "@vgpu/render/perf", replacement: resolve("packages/render/src/perf/index.ts") },
    ],
  },
});

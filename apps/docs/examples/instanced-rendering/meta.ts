export const meta = {
  slug: "instanced-rendering",
  title: "Instanced Rendering",
  description:
    "One cube mesh + one instance stream, with 125,000 independently animated cubes.",
  tags: ["instancing", "indirect-rendering", "performance"],
  capabilities: [
    "webgpu",
    "select-control",
    "instanced-rendering",
    "offscreen-rendering",
    "responsive-canvas",
  ],
  thumb: { warmupFrames: 3, dt: 1 / 60, time: 2.4 },
  files: [
    "index.tsx",
    "renderer.ts",
    "scene-pipeline.ts",
    "scene.wgsl",
    "blit.wgsl",
  ],
} as const;

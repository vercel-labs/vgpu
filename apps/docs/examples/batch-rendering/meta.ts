export const meta = {
  slug: "batch-rendering",
  title: "Batch Rendering",
  description:
    "Four primitive ranges in one mesh, recorded once as a render bundle.",
  tags: ["batch-rendering", "render-bundles", "instancing"],
  capabilities: ["webgpu", "render-bundles", "offscreen-rendering", "resize"],
  thumb: { warmupFrames: 3, dt: 1 / 60, time: 2.4 },
  files: [
    "index.tsx",
    "renderer.ts",
    "scene-pipeline.ts",
    "scene.wgsl",
    "blit.wgsl",
  ],
} as const;

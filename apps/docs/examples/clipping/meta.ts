export const meta = {
  slug: "clipping",
  title: "Clipping",
  description:
    "A single signed-distance test slices an animated icosphere, while a fitted disk reveals the moving cross-section.",
  tags: ["clipping", "3d", "shader"],
  capabilities: ["webgpu", "continuous-rendering", "responsive-canvas"],
  thumb: { time: 2.4 },
  files: ["index.tsx", "renderer.ts", "scene.ts", "clipped.wgsl"],
} as const;

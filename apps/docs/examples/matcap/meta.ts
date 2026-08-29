export const meta = {
  slug: "matcap",
  title: "Matcap Shading",
  description:
    "A lighting rig baked once into a sphere-shaped lookup texture, then replayed as a single texture fetch per pixel on a spinning faceted solid.",
  tags: ["matcap", "lighting", "shader", "3d"],
  capabilities: [
    "webgpu",
    "textures",
    "offscreen-rendering",
    "continuous-rendering",
    "responsive-canvas",
  ],
  thumb: { time: 3.1 },
  files: ["index.tsx", "renderer.ts", "scene.ts", "bake-matcap.wgsl", "matcap.wgsl"],
} as const;

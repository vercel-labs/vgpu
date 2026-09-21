export const meta = {
  slug: "gradient",
  title: "Simple Gradient",
  description:
    "Map screen coordinates to color with a tiny fullscreen fragment shader.",
  tags: ["gradient", "shader"],
  capabilities: ["webgpu", "fragment-shader", "responsive-canvas"],
  files: ["index.tsx", "renderer.ts", "shader.wgsl"],
} as const;

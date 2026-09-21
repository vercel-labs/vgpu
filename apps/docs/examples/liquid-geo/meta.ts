export const meta = {
  slug: "liquid-geo",
  title: "Liquid Geo",
  description:
    "A responsive metallic particle shell that fluidly morphs between an abstract form and a procedural Earth.",
  tags: ["particles", "simulation", "compute", "lighting", "animation"],
  capabilities: [
    "webgpu",
    "compute-shader",
    "storage-buffers",
    "instanced-rendering",
    "pointer-input",
    "continuous-rendering",
    "responsive-canvas",
    "select-control",
  ],
  thumb: {
    warmupFrames: 90,
    dt: 1 / 60,
    time: 2.8,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  },
  files: [
    "index.tsx",
    "renderer.ts",
    "pointer-input.ts",
    "simulation.ts",
    "simulate.wgsl",
    "particles.wgsl",
    "background.wgsl",
    "present.wgsl",
  ],
} as const;

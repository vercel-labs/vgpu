export const meta = {
  slug: "typegpu-liquid-glass",
  title: "TypeGPU Liquid Glass",
  description:
    "A refractive TypeGPU logo made with TypeScript GPU functions, translated into WGSL and rendered with vgpu.",
  tags: ["typegpu", "shader", "frosted-glass", "post-processing"],
  capabilities: [
    "webgpu",
    "multi-pass",
    "continuous-rendering",
    "responsive-canvas",
  ],
  thumb: { warmupFrames: 90, dt: 1 / 60, time: 2.4 },
  files: ["index.tsx", "renderer.ts"],
} as const;

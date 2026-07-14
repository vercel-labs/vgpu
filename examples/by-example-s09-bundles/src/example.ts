import { init } from "vgpu/node";

const FLOOR = /* wgsl */ `
struct Params { fogDensity: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(params.fogDensity, uv.x, uv.y, 1.0); }
`;

export async function runBundlesExample() {
  const gpu = await init({ size: [8, 8] });
  const scene = gpu.target({ size: [8, 8], format: "rgba8unorm" });
  const floor = gpu.pass(FLOOR, { label: "floor", set: { fogDensity: 0.2 } });
  const staticScene = gpu.bundle({ target: scene, label: "staticScene" }, (b) => { b.draw(floor); });
  floor.set({ fogDensity: 0.7 });
  gpu.frame((frame) => frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.bundles(staticScene)));
  return { gpu, target: scene };
}

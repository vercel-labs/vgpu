import { init } from "vgpu/node";

const GRADIENT = /* wgsl */ `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.x + params.time * 0.1, uv.y, params.speed, 1.0);
}
`;

export async function renderGradientHeadless() {
  const gpu = await init({ size: [8, 8] });
  const target = gpu.target({ size: [8, 8], format: "rgba8unorm" });
  const p = gpu.pass(GRADIENT, { label: "gradient" });
  p.set({ time: 1.25, speed: 1 });
  p.draw({ target });
  return { gpu, target };
}

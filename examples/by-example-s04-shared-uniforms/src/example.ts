import { init } from "vgpu/node";

export const WAVE = /* wgsl */ `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv.x, globals.mouse.x, globals.time, 1.0);
}
`;

export const TINT = /* wgsl */ `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> g: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(g.time, uv.y, g.mouse.y, 1.0);
}
`;

export async function runSharedUniformsExample() {
  const gpu = await init();
  const target = gpu.target({ size: [8, 8], format: "rgba8unorm" });
  const globals = gpu.uniforms({ time: 0.2, mouse: [0.4, 0.6] });
  const wave = gpu.pass(WAVE, { label: "wave", set: { globals } });
  const tint = gpu.pass(TINT, { label: "tint", set: { g: globals } });
  globals.set({ time: 0.8 });
  gpu.frame((frame) => {
    frame.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(wave));
    frame.pass({ target }, (p) => p.draw(tint));
  });
  return { gpu, target };
}

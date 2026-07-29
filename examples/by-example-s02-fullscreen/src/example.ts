import { init, effect, frame, target } from "vgpu/node";

export const WAVE = /* wgsl */ `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * .5 + .5, 1);
}
`;

export async function runFullscreenExample() {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [8, 8], format: "rgba8unorm" });
  const wave = effect(gpu, WAVE, { label: "wave", set: { speed: 2 } });
  wave.set({ time: Math.PI / 4 });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (p) => p.draw(wave)));
  return { gpu, target: colorTarget };
}

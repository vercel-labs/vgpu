import { init, bundle, effect, frame, target } from "vgpu/node";

export const FLOOR = /* wgsl */ `
struct Params { fogDensity: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(params.fogDensity, uv.x, uv.y, 1.0); }
`;

export async function runBundlesExample() {
  const gpu = await init();
  const scene = target(gpu, { size: [8, 8], format: "rgba8unorm" });
  const floor = effect(gpu, FLOOR, { label: "floor", set: { fogDensity: 0.2 } });
  const staticScene = bundle(gpu, { target: scene, label: "staticScene" }, (b) => { b.draw(floor); });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.bundles(staticScene)));
  const before = new Uint8Array(await scene.read());

  floor.set({ fogDensity: 0.7 });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.bundles(staticScene)));
  const after = new Uint8Array(await scene.read());

  return { gpu, target: scene, before, after };
}

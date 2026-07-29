/**
 * Consumer-cost fixture for a fullscreen effect. It deliberately uses the post-T202-05 gpu-first
 * API rather than the temporary `effect` facade. `pnpm bundle-check --experiences` is expected
 * to fail to resolve these named exports until that clean cut and its ceilings have landed.
 */
import { effect, frame, init, surface } from "vgpu";

const FRAGMENT = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}`;

export async function renderEffect(canvas: HTMLCanvasElement) {
  const gpu = await init();
  const target = surface(gpu, canvas);
  const fullscreen = effect(gpu, FRAGMENT);
  frame(gpu, (next) => next.pass({ target }, (pass) => pass.draw(fullscreen)));
  return gpu;
}

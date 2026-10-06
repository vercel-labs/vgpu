/**
 * Recipe bridge fixture. Unlike triangle-low-level, this is allowed to reach scene primitive code;
 * it establishes the separately-budgeted cost of asking the gpu-first geometry factory for `box`.
 */
import { prepareShader } from "@vgpu/wgsl/prepare";
import { draw, frame, geometry, init, surface } from "vgpu";
import { box } from "vgpu/scene";

const MATERIAL = `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array<vec2f, 3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
  return vec4f(points[index], 0.0, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(0.7, 0.4, 0.2, 1.0); }`;
const MATERIAL_SHADER = prepareShader(
  MATERIAL,
  "bundle-fixture-draw-recipe-box.wgsl"
);

export async function renderBox(canvas: HTMLCanvasElement) {
  const gpu = await init();
  const target = surface(gpu, canvas);
  const mesh = geometry(gpu, box());
  const boxDraw = draw(gpu, { geometry: mesh, shader: MATERIAL_SHADER });
  frame(gpu, (next) => next.pass({ target }, (pass) => pass.draw(boxDraw)));
  return gpu;
}

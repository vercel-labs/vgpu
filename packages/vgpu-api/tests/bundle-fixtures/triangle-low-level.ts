/**
 * Low-level triangle path. The descriptor is intentionally inline: this fixture must prove that
 * `geometry(gpu, descriptor)` does not retain the scene recipe factory or its primitive meshes.
 * It uses the canonical gpu-first names of the 0.2.0 API.
 */
import { draw, frame, geometry, init, surface } from "vgpu";

const TRIANGLE = `
@vertex fn vertex(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1.0); }`;

export async function renderTriangle(canvas: HTMLCanvasElement) {
  const gpu = await init();
  const target = surface(gpu, canvas);
  const mesh = geometry(gpu, {
    topology: "triangle-list",
    buffers: [{
      data: new Float32Array([0.0, 0.5, -0.5, -0.5, 0.5, -0.5]),
      stride: 8,
      attributes: { position: "float32x2" },
    }],
  });
  const triangle = draw(gpu, { geometry: mesh, shader: TRIANGLE });
  frame(gpu, (next) => next.pass({ target }, (pass) => pass.draw(triangle)));
  return gpu;
}

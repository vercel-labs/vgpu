import { init, Uniform } from "vgpu/node";

export const SHARED_CAMERA = /* wgsl */ `
struct Camera { exposure: f32 }
@group(0) @binding(0) var<uniform> camera: Camera;
struct Params { color: vec4f }
@group(0) @binding(1) var<uniform> params: Params;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  let pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
`;

export const CUBE = /* wgsl */ `
${SHARED_CAMERA}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (uv.x >= 0.5) { discard; }
  return vec4f(params.color.rgb * camera.exposure, params.color.a);
}
`;

export const FLOOR = /* wgsl */ `
${SHARED_CAMERA}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (uv.x < 0.5) { discard; }
  return vec4f(params.color.rgb * camera.exposure, params.color.a);
}
`;

export async function runSharingExample() {
  const gpu = await init();
  const target = gpu.target({ size: [16, 16], format: "rgba8unorm" });
  const camera = new Uniform(gpu.device, { size: 16, label: "camera" });
  camera.write(new Float32Array([1, 0, 0, 0]));

  const cube = gpu.draw({ shader: CUBE, label: "cube" });
  const floor = gpu.draw({ shader: FLOOR, label: "floor" });
  cube.set({ camera, params: { color: [1, 0, 0, 1] } });
  floor.set({ camera, params: { color: [0, 1, 0, 1] } });

  gpu.frame((frame) => {
    frame.pass({ target, clear: [0, 0, 0, 1] }, (p) => {
      p.draw(cube);
      p.draw(floor);
    });
  });
  return { gpu, target, camera };
}

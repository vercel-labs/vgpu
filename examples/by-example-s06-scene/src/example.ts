import { init } from "vgpu/node";
import { box, orbit, perspectiveCamera } from "vgpu/scene";

export const LIT_WGSL = /* wgsl */ `
struct Camera { viewProjection: mat4x4f }
struct Model { model: mat4x4f }
struct Light { direction: vec3f, intensity: f32 }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> light: Light;
struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f };
@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = camera.viewProjection * model.model * vec4f(position, 1.0);
  out.normal = normal;
  return out;
}
@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let n = normalize(normal);
  let l = max(dot(n, normalize(-light.direction)), 0.15) * light.intensity;
  return vec4f(vec3f(0.2, 0.5, 1.0) * l, 1.0);
}
`;

export async function runSceneExample() {
  const gpu = await init();
  const target = gpu.target({ size: [32, 32], format: "rgba8unorm", depth: true });
  const cam = perspectiveCamera({ fov: 45, aspect: 1, position: [2, 2, 3], target: [0, 0, 0] });
  const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box({ size: 1 })), label: "cube", targets: [target] });
  cube.set({ camera: { viewProjection: cam.viewProjection }, model: { model: orbit(0) }, light: { direction: [-1, -1, -1], intensity: 1 } });
  gpu.frame((frame) => frame.pass({ target, clear: [0.05, 0.05, 0.08, 1] }, (p) => p.draw(cube)));
  return { gpu, target };
}

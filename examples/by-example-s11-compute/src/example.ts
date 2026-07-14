import { init } from "vgpu/node";

const SIM = /* wgsl */ `
struct Sim { dt: f32 }
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  dst[id.x] = src[id.x] + vec4f(0.0, -9.8 * sim.dt, 0.0, 0.0);
}
`;

export async function runComputeExample() {
  const gpu = await init({ size: [1, 1] });
  const src = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst", "copy_src"], label: "src" });
  const dst = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst", "copy_src"], label: "dst" });
  src.write(new Float32Array([1, 2, 3, 4]));
  const sim = gpu.compute(SIM, { label: "sim" });
  sim.set({ dt: 0.5, src, dst });
  sim.dispatch(1);
  return { gpu, dst };
}

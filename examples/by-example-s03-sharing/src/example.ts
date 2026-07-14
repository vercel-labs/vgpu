import { init } from "vgpu/node";

const COUNT = 4;
const SIZE_BYTES = COUNT * 16;

export const PARTICLES = /* wgsl */ `
@group(0) @binding(0) var<storage, read> particles: array<vec4f>;
@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 6>(vec2f(-0.03,-0.03), vec2f(0.03,-0.03), vec2f(-0.03,0.03), vec2f(-0.03,0.03), vec2f(0.03,-0.03), vec2f(0.03,0.03));
  let p = particles[ii];
  return vec4f(p.xy + corners[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.4, 0.1, 1.0); }
`;

export async function runSharingExample() {
  const gpu = await init({ size: [16, 16], requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  const target = gpu.target({ size: [16, 16], format: "rgba8unorm" });
  const particles = gpu.device.createBuffer({ size: SIZE_BYTES, usage: ["storage", "copy_dst", "copy_src"], label: "particles" });
  particles.write(new Float32Array([-0.5, 0, 0, 0, -0.15, 0, 0, 0, 0.15, 0, 0, 0, 0.5, 0, 0, 0]));
  const dots = gpu.draw({ shader: PARTICLES, set: { particles }, label: "dots" }) as ReturnType<typeof gpu.draw> & { opts: { vertices?: number; instances?: number } };
  // Current DrawOptions has not landed public vertices/instances knobs; this example records the shader and shared storage binding.
  gpu.frame((frame) => frame.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(dots)));
  return { gpu, target };
}

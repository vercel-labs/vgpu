import { init } from "vgpu/node";

const CLAIMED = /* wgsl */ `
struct Params { color: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return params.color; }
`;

export async function runGroupClaimExample() {
  const gpu = await init({ size: [8, 8] });
  const target = gpu.target({ size: [8, 8], format: "rgba8unorm" });
  const draw = gpu.draw({ shader: CLAIMED, label: "claimed" });
  const layout = draw.layout(0, { dynamicOffsets: true });
  const buffer = gpu.device.createBuffer({ size: 256, usage: ["uniform", "copy_dst", "copy_src"], label: "claimed-uniform" });
  buffer.write(new Float32Array([0.9, 0.2, 0.1, 1]));
  const bindGroup = gpu.gpu.createBindGroup({ label: "claimed-bg", layout, entries: [{ binding: 0, resource: { buffer: buffer.gpu, offset: 0, size: 16 } }] });
  draw.group(0, bindGroup);
  const frame = gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(draw, { offsets: { 0: [0] } })));
  await frame.done;
  return { gpu, target };
}

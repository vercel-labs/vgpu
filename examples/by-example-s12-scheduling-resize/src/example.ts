import { init } from "vgpu/node";

export const POST = /* wgsl */ `
struct Params { time: f32, texel: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(params.texel, params.time, 1.0); }
`;

export async function runSchedulingResizeExample() {
  const gpu = await init();
  const baked = gpu.target({ size: [4, 4], format: "rgba8unorm" });
  const post = gpu.effect(POST, { label: "post" });
  gpu.frame((f) => f.pass({ target: baked }, (p) => { post.set({ time: 0.25, texel: baked.texelSize }); p.draw(post); }));
  baked.resize([8, 8]);
  gpu.frame((f) => f.pass({ target: baked }, (p) => { post.set({ time: 0.5, texel: baked.texelSize }); p.draw(post); }));
  return { gpu, target: baked };
}

import { init } from "vgpu/node";

export const SOLID = /* wgsl */ `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(0.25 + uv.x * 0.5, 0.5, 0.75, 1.0); }
`;
export const POST = /* wgsl */ `
struct PostParams { texel: vec2f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: PostParams;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(vec2f(uv) / params.texel), 0);
  return vec4f(c.rgb, 1.0);
}
`;

export async function runHdrPostExample() {
  const gpu = await init({ size: [8, 8] });
  const scene = gpu.target({ size: [8, 8], format: "rgba16float", depth: true, label: "scene" });
  const output = gpu.target({ size: [8, 8], format: "rgba8unorm", label: "output" });
  const solid = gpu.pass(SOLID, { label: "solid" });
  const post = gpu.pass(POST, { label: "post" });
  gpu.frame((frame) => {
    frame.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(solid));
    frame.pass({ target: output }, (p) => { post.set({ src: scene.color, texel: scene.texelSize }); p.draw(post); });
  });
  return { gpu, scene, output };
}

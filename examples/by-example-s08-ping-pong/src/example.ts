import { init } from "vgpu/node";

export const FILL = /* wgsl */ `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.5, 1.0); }
`;
export const COPY = /* wgsl */ `
struct Params { texel: vec2f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureLoad(src, vec2u(vec2f(uv) / params.texel), 0);
}
`;

export async function runPingPongExample() {
  const gpu = await init();
  const buf = gpu.pingPong(8, 8, { format: "rgba8unorm" });
  const fill = gpu.effect(FILL, { label: "fill" });
  const copy = gpu.effect(COPY, { label: "copy" });
  gpu.frame((frame) => frame.pass({ target: buf.write }, (p) => p.draw(fill)));
  buf.swap();
  gpu.frame((frame) => frame.pass({ target: buf.write }, (p) => { copy.set({ src: buf.read, texel: buf.read.texelSize }); p.draw(copy); }));
  return { gpu, target: buf.write };
}

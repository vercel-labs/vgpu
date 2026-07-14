export const nodeSource = `import { init } from "vgpu/node";

const shader = /* wgsl */ \`
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1.0);
}
\`;

const gpu = await init({ size: [256, 256] });
const target = gpu.target({ format: "rgba8unorm" });
const pass = gpu.pass(shader, { set: { time: 1.25, speed: 1 } });
pass.draw({ target });
console.log((await target.read()).byteLength);
gpu.dispose();
`;

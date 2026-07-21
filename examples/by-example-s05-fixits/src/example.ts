import { init } from "vgpu/mock";

const NEEDS_SAMPLER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
fn useSampler(value: sampler) {}
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { useSampler(samp); return vec4f(uv, 0.0, 1.0); }
`;

const SPEED = /* wgsl */ `
struct Params { speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(params.speed, uv, 1.0); }
`;

export async function collectFixitMessages() {
  const gpu = await init();
  try {
    const missing = gpu.effect(NEEDS_SAMPLER, { label: "lighting" });
    const ownership = gpu.effect(SPEED, { label: "wave", set: { speed: 2 } });
    const messages: string[] = [];
    try { missing.draw({ target: gpu.target({ size: [4, 4] }) }); } catch (error) { messages.push(String((error as Error).message)); }
    try { ownership.set({ speed: gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] }) }); } catch (error) { messages.push(String((error as Error).message)); }
    return messages;
  } finally {
    gpu.dispose();
  }
}

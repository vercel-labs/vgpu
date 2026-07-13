import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";

const WAVE = `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, params.time * params.speed, 1.0);
}
`;

const SAMPLER_SHADER = `
@group(0) @binding(0) var samp: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }
`;

const CAMERA_SHADER = `
struct Camera { value: f32 }
@group(0) @binding(0) var<uniform> camera: Camera;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(camera.value, uv, 1.0); }
`;

test("set() writes lib-owned values in-place and keeps bind group stable on mock", async () => {
  const gpu = await init({ size: [4, 4] });
  const wave = gpu.pass(WAVE, { label: "wave" });
  const target = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ speed: 2 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));
  wave.set({ time: 0.5 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("creation-time set sugar is exactly an initial set()", async () => {
  const gpu = await init({ size: [4, 4] });
  const wave = gpu.pass(WAVE, { label: "wave", set: { speed: 2 } });
  const target = gpu.target({ size: [4, 4] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  wave.set({ time: 0.25 });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(wave)));

  expect(mock.calls.createBuffer).toBe(1);
  expect(mock.calls.createBindGroup).toBe(1);
  gpu.dispose();
});

test("R1 ownership flip reports canonical fix-it text", async () => {
  const gpu = await init({ size: [4, 4] });
  const wave = gpu.pass(WAVE, { label: "wave" });
  wave.set({ speed: 2 });
  const userBuffer = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });

  expect(() => wave.set({ speed: userBuffer })).toThrowError(
    "`speed` es lib-owned desde su primer set() (valor JS). No se puede cambiar el ownership\n" +
      "  de un binding. Si necesitás compartir el buffer entre passes, creá un recurso ring-0 y pasalo desde\n" +
      "  el inicio:  const speed = new Uniform(gpu.device, { size: 4 });  wave.set({ speed });",
  );
  gpu.dispose();
});

test("binding never set, including samplers, reports canonical no-phantom-resource error", async () => {
  const gpu = await init({ size: [4, 4] });
  const lighting = gpu.pass(SAMPLER_SHADER, { label: "lighting" });
  const target = gpu.target({ size: [4, 4] });

  expect(() => gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(lighting)))).toThrowError(
    "el binding `samp` (@group(0) @binding(0), sampler) de 'lighting' nunca fue seteado. Opciones:\n" +
      "    lighting.set({ samp: gpu.sampler() })            // valor canónico cacheado\n" +
      "    lighting.group(0, miBindGroup)                   // o reclamá el grupo entero\n" +
      "  Nunca se crean recursos fantasma por vos.",
  );
  gpu.dispose();
});

test("R2 cache hits when alternating between two user-owned resource identities", async () => {
  const gpu = await init({ size: [4, 4] });
  const draw = gpu.pass(CAMERA_SHADER, { label: "cameraPass" });
  const target = gpu.target({ size: [4, 4] });
  const a = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const b = gpu.device.createBuffer({ size: 4, usage: ["uniform", "copy_dst"] });
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  draw.set({ camera: a });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));
  draw.set({ camera: b });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));
  draw.set({ camera: a });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(draw)));

  expect(mock.calls.createBindGroup).toBe(2);
  gpu.dispose();
});

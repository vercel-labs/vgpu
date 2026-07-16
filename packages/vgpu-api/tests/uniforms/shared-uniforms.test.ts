import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { describe, expect, test } from "vitest";
import { init } from "../../src/mock.ts";
import { drawBindingState } from "../../src/draw.ts";
import { effectDraw } from "../../src/effect.ts";

const WAVE_WGSL = `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time, globals.mouse, 1.0);
}
`;

const BLUR_WGSL = `
struct BlurGlobals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: BlurGlobals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time, globals.mouse, 1.0);
}
`;

const BLUR_BAD_WGSL = `
struct BlurGlobals { time: vec2f, mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: BlurGlobals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time.x, globals.mouse, 1.0);
}
`;

const PADDED_WGSL = `
struct Globals { time: f32, @align(16) mouse: vec2f }
@group(0) @binding(0) var<uniform> globals: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time, globals.mouse, 1.0);
}
`;

const OVERRIDE_NAME_WGSL = `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<uniform> g: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(g.time, g.mouse, 1.0);
}
`;

const STORAGE_WGSL = `
struct Globals { time: f32, mouse: vec2f }
@group(0) @binding(0) var<storage, read> globals: Globals;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(globals.time, globals.mouse, 1.0);
}
`;

describe("gpu.uniforms() shared uniforms", () => {
  test("defers layout adoption and allocates only on first bind", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    expect(mock.calls.createBuffer).toBe(0);
    const wave = gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });

    expect(mock.calls.createBuffer).toBe(1);
    const state = drawBindingState(effectDraw(wave), "globals");
    expect(state?.ownership).toBe("user");
    expect(mock.createBufferDescriptors[0]).toMatchObject({ size: 16, label: "globals.sharedUniform" });
    gpu.dispose();
  });

  test("rejects incompatible later structs with the canonical fix-it text", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });

    gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });

    expect(() => gpu.effect(BLUR_BAD_WGSL, { label: "BLUR_WGSL", set: { globals } })).toThrowError(
      "shared uniforms 'globals' ya tiene layout { time: f32, mouse: vec2f } (adoptado de WAVE_WGSL);\n" +
        "  BLUR_WGSL declara { time: vec2f, ... } — alineá los structs o usá dos uniforms distintos.",
    );
    gpu.dispose();
  });

  test("rejects same named members when reflected byte layout differs", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });

    gpu.effect(PADDED_WGSL, { label: "PADDED_WGSL", set: { globals } });

    expect(() => gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } })).toThrowError(
      "shared uniforms 'globals' ya tiene layout { time: f32, mouse: vec2f } (adoptado de PADDED_WGSL);\n" +
        "  WAVE_WGSL declara { time: f32, ... } — alineá los structs o usá dos uniforms distintos.",
    );
    gpu.dispose();
  });

  test("one in-place write is visible to both consumers without reallocating buffers or bind groups", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
    const wave = gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
    const blur = gpu.effect(BLUR_WGSL, { label: "BLUR_WGSL", set: { globals } });
    const target = gpu.target({ size: [4, 4] });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    gpu.frame((frame) => {
      frame.pass({ target }, (pass) => {
        pass.draw(wave);
        pass.draw(blur);
      });
    });
    const bindGroupsAfterFirstFrame = mock.calls.createBindGroup;

    globals.set({ time: 2, mouse: [3, 4] });
    gpu.frame((frame) => {
      frame.pass({ target }, (pass) => {
        pass.draw(wave);
        pass.draw(blur);
      });
    });

    const resource = drawBindingState(effectDraw(wave), "globals")?.resource as GPUBufferBinding;
    expect(resource.buffer).toBe((drawBindingState(effectDraw(blur), "globals")?.resource as GPUBufferBinding).buffer);
    expect(mock.calls.createBuffer).toBe(1);
    expect(mock.calls.createBindGroup).toBe(bindGroupsAfterFirstFrame);
    expect(bindGroupsAfterFirstFrame).toBe(2);
    expect("__vgpuMockBytes" in resource.buffer).toBe(true);
    const bytes = resource.buffer.__vgpuMockBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(0, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getFloat32(12, true)).toBe(4);
    gpu.dispose();
  });

  test("set() batches a partial update into one writeBuffer call", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
    gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
    let writes = 0;
    const originalWriteBuffer = gpu.device.gpu.queue.writeBuffer.bind(gpu.device.gpu.queue);
    gpu.device.gpu.queue.writeBuffer = ((...args: Parameters<GPUQueue["writeBuffer"]>) => {
      writes += 1;
      return originalWriteBuffer(...args);
    }) as GPUQueue["writeBuffer"];

    globals.set({ time: 1, mouse: [2, 3] });

    expect(writes).toBe(1);
    gpu.dispose();
  });

  test("binding name is chosen by each shader", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
    const wave = gpu.effect(WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
    const override = gpu.effect(OVERRIDE_NAME_WGSL, { label: "OVERRIDE_WGSL", set: { g: globals } });

    expect(drawBindingState(effectDraw(wave), "globals")?.ownership).toBe("user");
    expect(drawBindingState(effectDraw(override), "g")?.ownership).toBe("user");
    expect((drawBindingState(effectDraw(wave), "globals")?.resource as GPUBufferBinding).buffer).toBe((drawBindingState(effectDraw(override), "g")?.resource as GPUBufferBinding).buffer);
    gpu.dispose();
  });

  test("storage address-space uses the same deferred-layout shared resource path", async () => {
    const gpu = await init();
    const globals = gpu.uniforms({ time: 0, mouse: [0, 0] });
    const storage = gpu.effect(STORAGE_WGSL, { label: "STORAGE_WGSL", set: { globals } });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    expect(drawBindingState(effectDraw(storage), "globals")?.ownership).toBe("user");
    expect(mock.createBufferDescriptors[0]?.usage).toBe(128 | 8);
    gpu.dispose();
  });
});

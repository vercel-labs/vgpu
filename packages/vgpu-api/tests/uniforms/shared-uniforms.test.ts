import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { describe, expect, test } from "vitest";
import { init, effect, frame, target } from "../../src/mock.ts";
import { drawBindingState } from "../../src/draw.ts";
import { effectDraw } from "../../src/effect.ts";
import { uniforms } from "../../src/uniforms.ts";

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

describe("uniforms(gpu) shared uniforms", () => {
  test("defers layout adoption and allocates only on first bind", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    expect(mock.calls.createBuffer).toBe(0);
    const wave = effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });

    expect(mock.calls.createBuffer).toBe(1);
    const state = drawBindingState(effectDraw(wave), "globals");
    expect(state?.ownership).toBe("user");
    expect(mock.createBufferDescriptors[0]).toMatchObject({ size: 16, label: "globals.sharedUniform" });
    gpu.dispose();
  });

  test("rejects incompatible later structs with the canonical fix-it text", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });

    effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });

    expect(() => effect(gpu, BLUR_BAD_WGSL, { label: "BLUR_WGSL", set: { globals } })).toThrowError(
      "Uniform 'globals' layout { time: f32, mouse: vec2f } from WAVE_WGSL != { time: vec2f, ... } from " +
        "BLUR_WGSL. Fix: align structs or split uniforms.",
    );
    gpu.dispose();
  });

  test("rejects same named members when reflected byte layout differs", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });

    effect(gpu, PADDED_WGSL, { label: "PADDED_WGSL", set: { globals } });

    expect(() => effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } })).toThrowError(
      "Uniform 'globals' layout { time: f32, mouse: vec2f } from PADDED_WGSL != { time: f32, ... } from " +
        "WAVE_WGSL. Fix: align structs or split uniforms.",
    );
    gpu.dispose();
  });

  test("one in-place write is visible to both consumers without reallocating buffers or bind groups", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    const wave = effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
    const blur = effect(gpu, BLUR_WGSL, { label: "BLUR_WGSL", set: { globals } });
    const colorTarget = target(gpu, { size: [4, 4] });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: colorTarget }, (pass) => {
        pass.draw(wave);
        pass.draw(blur);
      });
    });
    const bindGroupsAfterFirstFrame = mock.calls.createBindGroup;

    globals.set({ time: 2, mouse: [3, 4] });
    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: colorTarget }, (pass) => {
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
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
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
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    const wave = effect(gpu, WAVE_WGSL, { label: "WAVE_WGSL", set: { globals } });
    const override = effect(gpu, OVERRIDE_NAME_WGSL, { label: "OVERRIDE_WGSL", set: { g: globals } });

    expect(drawBindingState(effectDraw(wave), "globals")?.ownership).toBe("user");
    expect(drawBindingState(effectDraw(override), "g")?.ownership).toBe("user");
    expect((drawBindingState(effectDraw(wave), "globals")?.resource as GPUBufferBinding).buffer).toBe((drawBindingState(effectDraw(override), "g")?.resource as GPUBufferBinding).buffer);
    gpu.dispose();
  });

  test("storage address-space uses the same deferred-layout shared resource path", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    const storage = effect(gpu, STORAGE_WGSL, { label: "STORAGE_WGSL", set: { globals } });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    expect(drawBindingState(effectDraw(storage), "globals")?.ownership).toBe("user");
    expect(mock.createBufferDescriptors[0]?.usage).toBe(128 | 8);
    gpu.dispose();
  });
});

// --- gpu-first factory (T202-03) ---------------------------------------------------------------

describe("uniforms(gpu, values)", () => {
  test("adopts the layout of the first shader that binds it and shares one buffer across effects", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const before = mock.createBufferDescriptors.length;

    const wave = effect(gpu, WAVE_WGSL, { set: { globals } });
    const blur = effect(gpu, BLUR_WGSL, { set: { globals } });
    effectDraw(wave);
    effectDraw(blur);

    // One adoption, one buffer: the second shader validates the layout instead of allocating.
    expect(mock.createBufferDescriptors.length - before).toBe(1);
    const waveBuffer = drawBindingState(effectDraw(wave), "globals")!.resource as GPUBufferBinding;
    const blurBuffer = drawBindingState(effectDraw(blur), "globals")!.resource as GPUBufferBinding;
    expect(waveBuffer.buffer).toBe(blurBuffer.buffer);

    globals.set({ time: 1 });
    gpu.dispose();
  });

  test("the adopted buffer is destroyed by gpu.dispose(), and a disposed gpu is refused up front", async () => {
    const gpu = await init();
    const globals = uniforms(gpu, { time: 0, mouse: [0, 0] });
    effectDraw(effect(gpu, WAVE_WGSL, { set: { globals } }));
    expect(() => globals.set({ time: 1 })).not.toThrow();

    gpu.dispose();
    // The kernel destroyed the adopted buffer, so a late write fails loudly instead of writing to a dead handle.
    expect(() => globals.set({ time: 2 })).toThrowError(/Buffer is destroyed/);
    try { uniforms(gpu, { time: 0 }); expect.unreachable("expected a throw"); }
    catch (error) { expect(error).toMatchObject({ code: "VGPU-GPU-DISPOSED", where: "uniforms" }); }
  });

  test("uniforms(gpu) never allocates for a value bag no shader binds", async () => {
    const gpu = await init();
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const before = mock.createBufferDescriptors.length;
    const unused = uniforms(gpu, { time: 0, mouse: [0, 0] });
    unused.set({ time: 3 });

    expect(mock.createBufferDescriptors.length).toBe(before);
    expect(() => gpu.dispose()).not.toThrow();
  });
});

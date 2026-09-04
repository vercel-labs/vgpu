import { afterEach, describe, expect, test, vi } from "vitest";
import { effect, frame, init, sampler, target } from "../src/mock.ts";
import type { VGPUError } from "../src/errors.ts";

const DEPTH_READ = `
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(vec3f(textureLoad(sceneDepth, vec2i(pos.xy), 0)), 1.0);
}
`;

const DEPTH_SAMPLE = `
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(vec3f(textureSample(sceneDepth, depthSampler, uv)), 1.0);
}
`;

let gpu: Awaited<ReturnType<typeof init>> | undefined;
afterEach(() => { gpu?.dispose(); gpu = undefined; });

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return (error as VGPUError).code; }
  return undefined;
}
function messageOf(fn: () => unknown): string {
  try { fn(); } catch (error) { const e = error as VGPUError; return `${e.message} ${e.fix ?? ""}`; }
  return "";
}

describe("sampleable target depth", () => {
  test("depth attachments carry texture_binding usage", async () => {
    gpu = await init();
    const scene = target(gpu, { size: [32, 32], depth: true });
    expect(scene.depth?.format).toBe("depth24plus");
    expect([...(scene.depth?.usage ?? [])]).toEqual(expect.arrayContaining(["render_attachment", "texture_binding"]));
  });

  test("target.depth binds to texture_depth_2d with a depth sample type", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const layoutSpy = vi.spyOn(device, "createBindGroupLayout");
    const scene = target(gpu, { size: [32, 32], depth: true });
    const output = target(gpu, { size: [32, 32] });
    const fog = effect(gpu, DEPTH_READ, { label: "fog", set: { sceneDepth: scene.depth } });
    expect(() => frame(gpu!, (current) => current.pass({ target: output }, (pass) => pass.draw(fog)))).not.toThrow();
    const descriptor = layoutSpy.mock.calls.find(([desc]) => desc?.label?.includes("fog.group0"))?.[0];
    expect(descriptor?.entries?.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("depth");
    layoutSpy.mockRestore();
  });

  test("a sampler paired with a depth texture gets a non-filtering layout", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const layoutSpy = vi.spyOn(device, "createBindGroupLayout");
    const scene = target(gpu, { size: [32, 32], depth: true });
    effect(gpu, DEPTH_SAMPLE, { label: "fog-sample", set: { sceneDepth: scene, depthSampler: sampler(gpu, { minFilter: "nearest", magFilter: "nearest" }) } });
    const descriptor = layoutSpy.mock.calls.find(([desc]) => desc?.label?.includes("fog-sample.group0"))?.[0];
    expect(descriptor?.entries?.find((entry) => entry.binding === 0)?.texture?.sampleType).toBe("depth");
    expect(descriptor?.entries?.find((entry) => entry.binding === 1)?.sampler?.type).toBe("non-filtering");
    layoutSpy.mockRestore();
  });

  test("a Target bound to a depth binding resolves to its depth texture", async () => {
    gpu = await init();
    const scene = target(gpu, { size: [32, 32], depth: true });
    const spy = vi.spyOn(scene.depth!.gpu, "createView");
    effect(gpu, DEPTH_READ, { label: "fog", set: { sceneDepth: scene } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a Target without depth is rejected with a fix-it", async () => {
    gpu = await init();
    const scene = target(gpu, { size: [32, 32] });
    const fog = effect(gpu, DEPTH_READ, { label: "fog" });
    expect(codeOf(() => fog.set({ sceneDepth: scene }))).toBe("VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE");
    expect(messageOf(() => fog.set({ sceneDepth: scene }))).toMatch(/depth: true/);
  });

  test("stencil formats are bound through a depth-only view", async () => {
    gpu = await init();
    const scene = target(gpu, { size: [32, 32], depth: "depth24plus-stencil8" });
    const spy = vi.spyOn(scene.depth!.gpu, "createView");
    effect(gpu, DEPTH_READ, { label: "fog", set: { sceneDepth: scene.depth } });
    expect(spy.mock.calls.at(-1)?.[0]?.aspect).toBe("depth-only");
    spy.mockRestore();
  });

  test("resizing a target rebinds the recreated depth texture", async () => {
    gpu = await init();
    const scene = target(gpu, { size: [32, 32], depth: true });
    const output = target(gpu, { size: [64, 64] });
    const fog = effect(gpu, DEPTH_READ, { label: "fog", set: { sceneDepth: scene } });
    scene.resize([64, 64]);
    expect(() => frame(gpu!, (current) => current.pass({ target: output }, (pass) => pass.draw(fog)))).not.toThrow();
    await gpu.settled();
  });
});

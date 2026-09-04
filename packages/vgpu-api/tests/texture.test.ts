import { afterEach, describe, expect, test, vi } from "vitest";
import { compute, effect, frame, init, sampler, target, texture } from "../src/mock.ts";
import type { VGPUError } from "../src/errors.ts";

const STORAGE_2D = `
@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, id.xy, vec4f(1.0)); }
`;

const STORAGE_3D = `
@group(0) @binding(0) var lut: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(lut, id, vec4f(1.0)); }
`;

const SAMPLE_3D = `
@group(0) @binding(0) var lut: texture_3d<f32>;
@group(0) @binding(1) var linear: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(lut, linear, vec3f(uv, 0.5)); }
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

describe("texture()", () => {
  test("creates a 2D texture with sampled + storage + copy usage by default", async () => {
    gpu = await init();
    const noise = texture(gpu, { size: [16, 8], format: "rgba8unorm", label: "noise" });
    expect(noise.size).toEqual([16, 8]);
    expect(noise.format).toBe("rgba8unorm");
    expect(noise.dimension).toBe("2d");
    expect([...noise.usage].sort()).toEqual(["copy_dst", "copy_src", "storage_binding", "texture_binding"]);
    expect(noise.label).toBe("noise");
    noise.destroy();
  });

  test("creates a 3D texture when dimension is 3d", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const spy = vi.spyOn(device, "createTexture");
    const lut = texture(gpu, { size: [32, 32, 32], format: "rgba16float", dimension: "3d" });
    expect(lut.dimension).toBe("3d");
    expect(lut.size).toEqual([32, 32, 32]);
    const desc = spy.mock.calls.at(-1)?.[0];
    expect(desc?.dimension).toBe("3d");
    expect(desc?.size).toEqual({ width: 32, height: 32, depthOrArrayLayers: 32 });
    spy.mockRestore();
  });

  test("explicit usage replaces the default", async () => {
    gpu = await init();
    const atlas = texture(gpu, { size: [4, 4, 8], format: "bgra8unorm", usage: ["texture_binding", "copy_dst"] });
    expect([...atlas.usage]).toEqual(["texture_binding", "copy_dst"]);
  });

  test("throws VGPU-TEXTURE-SIZE-REQUIRED without a valid size", async () => {
    gpu = await init();
    const g = gpu;
    expect(codeOf(() => texture(g, { format: "rgba8unorm" } as never))).toBe("VGPU-TEXTURE-SIZE-REQUIRED");
    expect(codeOf(() => texture(g, { size: [0, 4], format: "rgba8unorm" }))).toBe("VGPU-TEXTURE-SIZE-REQUIRED");
    expect(codeOf(() => texture(g, { size: [4, 4, 0], format: "rgba8unorm" }))).toBe("VGPU-TEXTURE-SIZE-REQUIRED");
  });

  test("throws VGPU-TEXTURE-STORAGE-FORMAT for a non-storage format with storage_binding usage", async () => {
    gpu = await init();
    const g = gpu;
    expect(codeOf(() => texture(g, { size: [4, 4], format: "bgra8unorm" }))).toBe("VGPU-TEXTURE-STORAGE-FORMAT");
    expect(messageOf(() => texture(g, { size: [4, 4], format: "rgb10a2unorm" }))).toMatch(/storage_binding/);
    expect(() => texture(g, { size: [4, 4], format: "bgra8unorm", usage: ["texture_binding"] })).not.toThrow();
  });
});

describe("storage texture bindings", () => {
  test("compute accepts a storage texture and reflects the layout", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const layoutSpy = vi.spyOn(device, "createBindGroupLayout");
    const out = texture(gpu, { size: [16, 16], format: "rgba8unorm" });
    const fill = compute(gpu, STORAGE_2D, { label: "fill" });
    fill.set({ out });
    expect(() => fill.dispatch(2, 2)).not.toThrow();
    const descriptor = layoutSpy.mock.calls.find(([desc]) => desc?.label?.includes("fill.group0"))?.[0];
    const entry = descriptor?.entries?.find((item) => item.binding === 0);
    expect(entry?.storageTexture).toEqual({ access: "write-only", format: "rgba8unorm", viewDimension: "2d" });
    expect(entry?.visibility).toBe(4);
    layoutSpy.mockRestore();
  });

  test("a 3D storage texture binds to texture_storage_3d and to texture_3d", async () => {
    gpu = await init();
    const lut = texture(gpu, { size: [8, 8, 8], format: "rgba16float", dimension: "3d" });
    const fill = compute(gpu, STORAGE_3D, { label: "fill-3d", set: { lut } });
    expect(() => fill.dispatch(2, 2, 2)).not.toThrow();
    const output = target(gpu, { size: [8, 8], format: "rgba8unorm" });
    const view = effect(gpu, SAMPLE_3D, { label: "view-3d", set: { lut, linear: sampler(gpu) } });
    expect(() => frame(gpu, (current) => current.pass({ target: output }, (pass) => pass.draw(view)))).not.toThrow();
  });

  test("storage view binds mip level 0 only", async () => {
    gpu = await init();
    const mipped = texture(gpu, { size: [16, 16], format: "rgba8unorm", mipLevelCount: 3 });
    const spy = vi.spyOn(mipped.gpu, "createView");
    compute(gpu, STORAGE_2D, { label: "fill-mips", set: { out: mipped } });
    const desc = spy.mock.calls.at(-1)?.[0];
    expect(desc?.mipLevelCount).toBe(1);
    expect(desc?.baseMipLevel ?? 0).toBe(0);
    spy.mockRestore();
  });

  test("rejects a Target for a storage texture binding", async () => {
    gpu = await init();
    const output = target(gpu, { size: [16, 16], format: "rgba8unorm" });
    const fill = compute(gpu, STORAGE_2D, { label: "fill" });
    expect(codeOf(() => fill.set({ out: output }))).toBe("VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE");
    expect(messageOf(() => fill.set({ out: output }))).toMatch(/texture\(gpu/);
  });

  test("rejects a texture without storage_binding usage", async () => {
    gpu = await init();
    const sampledOnly = texture(gpu, { size: [16, 16], format: "rgba8unorm", usage: ["texture_binding"] });
    const fill = compute(gpu, STORAGE_2D, { label: "fill" });
    expect(codeOf(() => fill.set({ out: sampledOnly }))).toBe("VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE");
    expect(messageOf(() => fill.set({ out: sampledOnly }))).toMatch(/storage_binding/);
  });

  test("rejects a format that differs from the WGSL declaration", async () => {
    gpu = await init();
    const wrongFormat = texture(gpu, { size: [16, 16], format: "rgba16float" });
    const fill = compute(gpu, STORAGE_2D, { label: "fill" });
    expect(codeOf(() => fill.set({ out: wrongFormat }))).toBe("VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE");
    expect(messageOf(() => fill.set({ out: wrongFormat }))).toMatch(/rgba8unorm/);
  });

  test("rejects a dimension that differs from the WGSL declaration", async () => {
    gpu = await init();
    const flat = texture(gpu, { size: [8, 8], format: "rgba16float" });
    const fill = compute(gpu, STORAGE_3D, { label: "fill-3d" });
    expect(codeOf(() => fill.set({ lut: flat }))).toBe("VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE");
    expect(messageOf(() => fill.set({ lut: flat }))).toMatch(/"3d"/);
  });

  test("destroying a bound storage texture evicts its bind group identity", async () => {
    gpu = await init();
    const out = texture(gpu, { size: [16, 16], format: "rgba8unorm" });
    const fill = compute(gpu, STORAGE_2D, { label: "fill", set: { out } });
    fill.dispatch(1);
    out.destroy();
    const replacement = texture(gpu, { size: [16, 16], format: "rgba8unorm" });
    fill.set({ out: replacement });
    expect(() => fill.dispatch(1)).not.toThrow();
  });
});

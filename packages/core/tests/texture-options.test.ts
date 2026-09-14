import { describe, expect, test, vi } from "vitest";
import { Device, ValidationError, type TextureOptions, type TextureShape } from "../src/index.ts";

function recordingDevice(features: string[] = [], limits: Partial<GPUSupportedLimits> = {}) {
  const createTexture = vi.fn((desc: GPUTextureDescriptor) => ({
    createView: vi.fn(), destroy: vi.fn(), sampleCount: desc.sampleCount ?? 1,
  }) as unknown as GPUTexture);
  const device = new Device({ createTexture, features: new Set(features), limits, queue: {}, destroy() {} } as unknown as GPUDevice);
  return { device, createTexture };
}

const base = { kind: "2d", size: [8, 4], format: "rgba8unorm", usage: ["texture_binding"] } as const;

describe("shared texture creation", () => {
  test.each<[TextureShape, GPUTextureDimension, number[]]>([
    [{ kind: "1d", size: [8] }, "1d", [8, 1, 1]],
    [{ kind: "2d", size: [8, 4] }, "2d", [8, 4, 1]],
    [{ kind: "3d", size: [8, 4, 2] }, "3d", [8, 4, 2]],
    [{ kind: "2d-array", size: [8, 4], layers: 6 }, "2d", [8, 4, 6]],
  ])("translates %j without changing semantic metadata", (shape, dimension, extent) => {
    const { device, createTexture } = recordingDevice();
    const texture = device.createTexture({ ...base, ...shape });
    expect(createTexture).toHaveBeenCalledExactlyOnceWith({
      label: undefined, dimension, format: "rgba8unorm", usage: 4,
      size: { width: extent[0], height: extent[1], depthOrArrayLayers: extent[2] },
      ...(shape.kind === "2d-array" ? { textureBindingViewDimension: "2d-array" } : {}),
    });
    expect(texture.kind).toBe(shape.kind);
    expect(texture.size).toEqual(shape.size);
    expect(texture.layers).toBe(shape.kind === "2d-array" ? shape.layers : 1);
    expect(texture.mipLevelCount).toBe(1);
    expect(texture.sampleCount).toBe(1);
    expect(texture.viewFormats).toEqual([]);
    texture.destroy();
  });

  test.each<[string, unknown, string]>([
    ["missing kind", { ...base, kind: undefined }, "KIND-REQUIRED"],
    ["unknown kind", { ...base, kind: "cube" }, "KIND-REQUIRED"],
    ["legacy dimension", { ...base, dimension: "2d" }, "KIND-REQUIRED"],
    ["missing size", { ...base, size: undefined }, "SIZE-REQUIRED"],
    ["zero", { ...base, size: [0, 4] }, "SIZE-REQUIRED"],
    ["negative", { ...base, size: [-1, 4] }, "SIZE-REQUIRED"],
    ["fraction", { ...base, size: [1.5, 4] }, "SIZE-REQUIRED"],
    ["NaN", { ...base, size: [NaN, 4] }, "SIZE-REQUIRED"],
    ["infinity", { ...base, size: [Infinity, 4] }, "SIZE-REQUIRED"],
    ["unsafe integer", { ...base, size: [Number.MAX_SAFE_INTEGER + 1, 4] }, "SIZE-REQUIRED"],
    ["sparse size", { ...base, size: new Array(2) }, "SIZE-REQUIRED"],
    ["ambiguous third entry", { ...base, size: [8, 4, 6] }, "SIZE-REQUIRED"],
    ["missing array layers", { ...base, kind: "2d-array" }, "LAYERS-INVALID"],
    ["zero layers", { ...base, kind: "2d-array", layers: 0 }, "LAYERS-INVALID"],
    ["plain texture with layers", { ...base, layers: 2 }, "LAYERS-INVALID"],
    ["missing usage", { ...base, usage: undefined }, "USAGE-REQUIRED"],
    ["empty usage", { ...base, usage: [] }, "USAGE-REQUIRED"],
    ["unknown usage", { ...base, usage: ["sampled"] }, "USAGE-REQUIRED"],
    ["sparse usage", { ...base, usage: new Array(1) }, "USAGE-REQUIRED"],
    ["missing format", { ...base, format: undefined }, "FORMAT-REQUIRED"],
    ["zero mips", { ...base, mipLevelCount: 0 }, "MIPS-INVALID"],
    ["too many mips", { ...base, mipLevelCount: 5 }, "MIPS-INVALID"],
    ["1D mips", { ...base, kind: "1d", size: [8], mipLevelCount: 2 }, "MIPS-INVALID"],
    ["unknown samples", { ...base, sampleCount: 2 }, "SAMPLES-INVALID"],
    ["MSAA without attachment", { ...base, sampleCount: 4 }, "SAMPLES-INVALID"],
    ["MSAA storage", { ...base, sampleCount: 4, usage: ["storage_binding", "render_attachment"] }, "SAMPLES-INVALID"],
    ["MSAA mips", { ...base, sampleCount: 4, mipLevelCount: 2, usage: ["render_attachment"] }, "SAMPLES-INVALID"],
    ["MSAA array", { ...base, kind: "2d-array", layers: 1, sampleCount: 4, usage: ["render_attachment"] }, "SAMPLES-INVALID"],
    ["1D attachment", { ...base, kind: "1d", size: [8], usage: ["render_attachment"] }, "KIND-INVALID"],
    ["1D depth", { ...base, kind: "1d", size: [8], format: "depth32float" }, "KIND-INVALID"],
    ["incompatible view", { ...base, viewFormats: ["bgra8unorm"] }, "VIEW-FORMAT"],
    ["sparse views", { ...base, viewFormats: new Array(1) }, "VIEW-FORMAT"],
  ])("rejects %s before native allocation", (_name, options, code) => {
    const { device, createTexture } = recordingDevice();
    expect(() => device.createTexture(options as TextureOptions)).toThrowError(ValidationError);
    expect(() => device.createTexture(options as TextureOptions)).toThrowError(expect.objectContaining({ code: `VGPU-TEXTURE-${code}` }));
    expect(createTexture).not.toHaveBeenCalled();
  });

  test("mips depend on spatial extent, not array layer count", () => {
    const { device, createTexture } = recordingDevice();
    expect(() => device.createTexture({ ...base, kind: "2d-array", size: [1, 1], layers: 64, mipLevelCount: 2 })).toThrowError(expect.objectContaining({ code: "VGPU-TEXTURE-MIPS-INVALID" }));
    const volume = device.createTexture({ ...base, kind: "3d", size: [1, 1, 16], mipLevelCount: 5 });
    expect(volume.mipLevelCount).toBe(5);
    expect(createTexture).toHaveBeenCalledTimes(1); // Allocation only: no generation resources.
  });

  test("uses enabled device features for storage formats", () => {
    const options = { ...base, format: "bgra8unorm", usage: ["storage_binding"] } as const;
    expect(() => recordingDevice().device.createTexture(options)).toThrowError(expect.objectContaining({ code: "VGPU-TEXTURE-STORAGE-FORMAT" }));
    expect(() => recordingDevice(["bgra8unorm-storage"]).device.createTexture(options)).not.toThrow();
    expect(() => recordingDevice().device.createTexture({ ...options, format: "r8unorm" })).toThrow();
    expect(() => recordingDevice(["texture-formats-tier1"]).device.createTexture({ ...options, format: "r8unorm" })).not.toThrow();
    expect(() => recordingDevice().device.createTexture({ ...base, format: "bgra8unorm" })).not.toThrow();
  });

  test.each<TextureShape>([
    { kind: "1d", size: [17] },
    { kind: "2d", size: [16, 17] },
    { kind: "3d", size: [8, 8, 17] },
    { kind: "2d-array", size: [8, 8], layers: 5 },
  ])("checks enabled limits for %j", (shape) => {
    const { device, createTexture } = recordingDevice([], { maxTextureDimension1D: 16, maxTextureDimension2D: 16, maxTextureDimension3D: 16, maxTextureArrayLayers: 4 });
    expect(() => device.createTexture({ ...base, ...shape })).toThrowError(expect.objectContaining({ code: "VGPU-TEXTURE-LIMIT" }));
    expect(createTexture).not.toHaveBeenCalled();
  });

  test("snapshots and freezes descriptor arrays without freezing caller data", () => {
    const { device, createTexture } = recordingDevice();
    const options = { kind: "2d-array", size: [8, 4], layers: 6, format: "rgba8unorm", usage: ["texture_binding"], viewFormats: ["rgba8unorm-srgb"] } satisfies TextureOptions;
    const texture = device.createTexture(options);
    options.size[0] = 99;
    options.layers = 1;
    options.usage.splice(0);
    options.viewFormats.length = 0;
    expect(texture.size).toEqual([8, 4]);
    expect(texture.layers).toBe(6);
    expect(texture.usage).toEqual(["texture_binding"]);
    expect(texture.viewFormats).toEqual(["rgba8unorm-srgb"]);
    expect(createTexture.mock.calls[0][0].viewFormats).toEqual(["rgba8unorm-srgb"]);
    for (const value of [texture.options, texture.size, texture.usage, texture.viewFormats]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (texture.size as unknown as number[])[0] = 99; }).toThrow(TypeError);
  });
});

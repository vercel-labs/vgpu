import { prepareShader } from "@vgpu/wgsl/prepare";
import { bundle, compute, draw, init, target } from "../src/mock.ts";
import { ComputePipeline } from "../src/compute.ts";
import { drawBindingState, InternalDraw, registerDrawBundle } from "../src/draw.ts";
import { expect, test, vi } from "vitest";

const PACKED_UNIFORM = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(params.value); }
`;

const PACKED_COMPUTE = `
struct Params { value: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { if (params.value == 0u) {} }
`;

test("dispose destroys a private packed buffer that was never exposed to native work", async () => {
  const gpu = await init();
  try {
    const destroyed = vi.fn();
    vi.spyOn(gpu.gpu, "createBuffer").mockImplementation(descriptor => nativeBuffer(descriptor, destroyed));
    const drawable = draw(gpu, { shader: prepareShader(PACKED_UNIFORM), set: { params: { value: 1 } } });

    drawable.dispose();

    expect(destroyed).toHaveBeenCalledOnce();
  } finally {
    gpu.dispose();
  }
});

test("Draw disposal preserves even a falsy notification failure after completing private cleanup", async () => {
  const gpu = await init();
  try {
    const destroyed = vi.fn();
    vi.spyOn(gpu.gpu, "createBuffer").mockImplementation(descriptor => nativeBuffer(descriptor, destroyed));
    const drawable = draw(gpu, { shader: prepareShader(PACKED_UNIFORM), set: { params: { value: 1 } } }) as InternalDraw;
    registerDrawBundle(drawable, { id: "failing-notification", markStale() { throw 0; } });
    const noFailure = Symbol("no failure");
    let failure: unknown = noFailure;

    try { drawable.dispose(); } catch (error) { failure = error; }

    expect(failure).toBe(0);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(() => drawable.dispose()).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("binding inspection permanently protects a private buffer from consumer destruction", async () => {
  const gpu = await init();
  try {
    const destroyed = vi.fn();
    vi.spyOn(gpu.gpu, "createBuffer").mockImplementation(descriptor => nativeBuffer(descriptor, destroyed));
    const drawable = draw(gpu, { shader: prepareShader(PACKED_UNIFORM), set: { params: { value: 1 } } }) as InternalDraw;

    expect(drawBindingState(drawable, "params")?.resource).toMatchObject({ offset: 0, size: 4 });
    drawable.dispose();

    expect(destroyed).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("failed native bind-group creation still protects a private buffer", async () => {
  const gpu = await init();
  try {
    const destroyed = vi.fn();
    vi.spyOn(gpu.gpu, "createBuffer").mockImplementation(descriptor => nativeBuffer(descriptor, destroyed));
    vi.spyOn(gpu.gpu, "createBindGroup").mockImplementation(() => { throw new Error("native bind-group failure"); });
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(PACKED_UNIFORM), set: { params: { value: 1 } } });

    expect(() => drawable.draw(output)).toThrow("native bind-group failure");
    drawable.dispose();

    expect(destroyed).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("failed bundle recording never makes its private buffer safe to destroy", async () => {
  const gpu = await init();
  try {
    const destroyed = vi.fn();
    vi.spyOn(gpu.gpu, "createBuffer").mockImplementation(descriptor => nativeBuffer(descriptor, destroyed));
    const output = target(gpu, { size: [1, 1] });
    const drawable = draw(gpu, { shader: prepareShader(PACKED_UNIFORM), set: { params: { value: 1 } } });
    const createEncoder = gpu.gpu.createRenderBundleEncoder.bind(gpu.gpu);
    vi.spyOn(gpu.gpu, "createRenderBundleEncoder").mockImplementation(descriptor => {
      const encoder = createEncoder(descriptor);
      encoder.finish = () => { throw new Error("bundle finish failure"); };
      return encoder;
    });

    expect(() => bundle(gpu, { target: output }, recorder => recorder.draw(drawable))).toThrow("bundle finish failure");
    drawable.dispose();

    expect(destroyed).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("a saved SetCore cannot inspect or mutate released Compute state", async () => {
  const gpu = await init();
  try {
    const pipeline = compute(gpu, prepareShader(PACKED_COMPUTE), { label: "saved-core", set: { params: { value: 1 } } }) as ComputePipeline;
    const saved = pipeline.setCore;

    pipeline.dispose();

    expect(() => saved.bindingState("params")).toThrowError(expect.objectContaining({
      code: "VGPU-COMPUTE-DISPOSED",
      where: "saved-core.bindingState",
    }));
    expect(() => saved.set({ params: { value: 2 } })).toThrowError(expect.objectContaining({
      code: "VGPU-COMPUTE-DISPOSED",
      where: "saved-core.set",
    }));
    expect(() => saved.groups).toThrowError(expect.objectContaining({
      code: "VGPU-COMPUTE-DISPOSED",
      where: "saved-core.groups",
    }));
  } finally {
    gpu.dispose();
  }
});

function nativeBuffer(descriptor: GPUBufferDescriptor, destroy: () => void): GPUBuffer {
  return {
    label: descriptor.label ?? "",
    size: descriptor.size,
    usage: descriptor.usage,
    mapState: "unmapped",
    destroy,
    getMappedRange: () => new ArrayBuffer(Number(descriptor.size)),
    mapAsync: async () => undefined,
    unmap() {},
  } as GPUBuffer;
}

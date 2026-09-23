import { afterEach, expect, test, vi } from "vitest";
import { bundle, compute, effect, frame, getMockGPUDeviceInstrumentation, init, target, uniforms } from "../../src/mock.ts";
import { createSharedUniforms } from "../../src/uniforms.ts";

const DECL = "struct Params { value:f32 } @group(0) @binding(0) var<uniform> params:Params;";
const FRAGMENT = `${DECL} @fragment fn main() -> @location(0) vec4f { return vec4f(params.value); }`;
const COMPUTE = `${DECL} @compute @workgroup_size(1) fn main() { let value = params.value; }`;
afterEach(() => vi.restoreAllMocks());

function setup(gpu: Awaited<ReturnType<typeof init>>, ownership: "owned" | "shared") {
  const shared = ownership === "shared" ? uniforms(gpu, { value: 1 }) : undefined;
  const fx = effect(gpu, FRAGMENT, { set: { params: shared ?? { value: 1 } } });
  const sim = compute(gpu, COMPUTE, { set: { params: shared ?? { value: 1 } } });
  const set = (value: number) => {
    if (shared) shared.set({ value });
    else { fx.set({ params: { value } }); sim.set({ params: { value } }); }
  };
  return { fx, sim, set };
}

function boundValues(gpu: Awaited<ReturnType<typeof init>>): number[] {
  return getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors.map(descriptor => {
    const binding = [...descriptor.entries][0]!.resource as GPUBufferBinding;
    const bytes = (binding.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
    return new DataView(bytes.buffer, bytes.byteOffset).getFloat32(binding.offset ?? 0, true);
  });
}

test.each(["owned", "shared"] as const)("%s frame uniforms only upload their captured page", async ownership => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const { fx, sim, set } = setup(gpu, ownership);
    const color = target(gpu, { size: [1, 1] });
    for (let i = 0; i < 100; i++) set(i);
    const f = frame(gpu);
    f.pass(color, fx);
    set(101);
    f.computePass(p => p.dispatch(sim, 1));
    set(102); // Unused revision must not replace either capture.
    expect(writes).not.toHaveBeenCalled();
    f.submit();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![0].label).toBe("vgpu.frame.uniforms");
    expect(boundValues(gpu)).toEqual([99, 101]);
    await f.done;
  } finally { gpu.dispose(); }
});

test.each(["owned", "shared"] as const)("%s one-shot draws and dispatches flush once per pending revision", async ownership => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const { fx, sim, set } = setup(gpu, ownership);
    const color = target(gpu, { size: [1, 1] });
    set(2); set(3);
    fx.draw(color);
    fx.draw(color);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(boundValues(gpu)).toEqual([3]);
    writes.mockClear();
    set(4); set(5);
    sim.dispatch(1);
    sim.dispatch(1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(boundValues(gpu).at(-1)).toBe(5);
  } finally { gpu.dispose(); }
});

test.each(["owned", "shared"] as const)("%s canceled frames upload nothing and retain CPU updates", async ownership => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const { sim, set } = setup(gpu, ownership);
    const f = frame(gpu);
    f.computePass(p => p.dispatch(sim, 1));
    set(8);
    f.cancel();
    expect(writes).not.toHaveBeenCalled();
    sim.dispatch(1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(boundValues(gpu).at(-1)).toBe(8);
  } finally { gpu.dispose(); }
});

test.each(["owned", "shared"] as const)("%s bundle bindings stay live after recording", async ownership => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const { fx, set } = setup(gpu, ownership);
    const color = target(gpu, { size: [1, 1] });
    const recorded = bundle(gpu, { target: color }, p => p.draw(fx));
    expect(writes).toHaveBeenCalledTimes(1);
    set(7);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(boundValues(gpu)).toEqual([7]);
    frame(gpu, f => f.pass(color, p => p.bundles(recorded)));
    expect(writes).toHaveBeenCalledTimes(2);
  } finally { gpu.dispose(); }
});

test.each(["buffer", "gpu"] as const)("exposing shared .%s flushes pending values and keeps the returned handle live", async key => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const params = createSharedUniforms(gpu.device, { value: 1 });
    expect(params[key]).toBeUndefined();
    effect(gpu, FRAGMENT, { set: { params } });
    params.set({ value: 2 });
    expect(writes).not.toHaveBeenCalled();
    const handle = params[key];
    expect(handle).toBeDefined();
    expect(writes).toHaveBeenCalledTimes(1);
    params.set({ value: 3 });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(params[key]).toBe(handle);
    expect(writes).toHaveBeenCalledTimes(2);
    params.destroy();
    expect(() => params.set({ value: 4 })).toThrow(/destroyed/i);
  } finally { gpu.dispose(); }
});

test("shared storage stays eager and binding never restores CPU bytes over GPU state", async () => {
  const gpu = await init();
  try {
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const params = createSharedUniforms(gpu.device, { value: 1 });
    const sim = compute(gpu, COMPUTE.replace("var<uniform>", "var<storage, read>"), { set: { params } });
    expect(writes).toHaveBeenCalledTimes(1);
    params.set({ value: 2 });
    expect(writes).toHaveBeenCalledTimes(2);
    const buffer = params.gpu as GPUBuffer & { __vgpuMockBytes: Uint8Array };
    new DataView(buffer.__vgpuMockBytes.buffer).setFloat32(0, 10, true);
    sim.dispatch(1);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(boundValues(gpu)).toEqual([10]);
    params.destroy();
  } finally { gpu.dispose(); }
});

test.each(["owned", "shared"] as const)("%s failed uploads remain pending for retry", async ownership => {
  const gpu = await init();
  try {
    const { fx } = setup(gpu, ownership);
    const color = target(gpu, { size: [1, 1] });
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer").mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => fx.draw(color)).toThrow("upload failed");
    fx.draw(color);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(boundValues(gpu)).toEqual([1]);
  } finally { gpu.dispose(); }
});

import { afterEach, expect, test, vi } from "vitest";
import { compute, effect, frame, init, storage, target, uniforms, getMockGPUDeviceInstrumentation, type FrameComputePass } from "../../src/mock.ts";

const EMPTY = "@compute @workgroup_size(1) fn main() {}";
const UNIFORM = "@group(0) @binding(0) var<uniform> value: f32; @compute @workgroup_size(1) fn main() { let x = value; }";
afterEach(() => vi.restoreAllMocks());

test("compute is lazy, compile is chainable and concurrent preparation shares native work", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, EMPTY);
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect(mock.calls.createComputePipeline).toBe(0);
    expect(await Promise.all([sim.compile(), sim.compile()])).toEqual([sim, sim]);
    expect(mock.calls.createComputePipelineAsync).toBe(1);
    sim.dispatch(1);
    expect(mock.calls.createComputePipeline).toBe(0);
  } finally { gpu.dispose(); }
});

test("a frame shares one encoder and submission across render and compute passes", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, EMPTY);
    const color = target(gpu, { size: [2, 2] });
    const submits = vi.spyOn(gpu.gpu.queue, "submit");
    const encoders = vi.spyOn(gpu.gpu, "createCommandEncoder");
    frame(gpu, f => {
      f.pass(color, () => {});
      f.computePass(p => { p.dispatch(sim, 1); p.dispatch(sim, 2, 3, 4); });
      f.pass(color, () => {});
      expect(submits).not.toHaveBeenCalled();
    });
    expect(submits).toHaveBeenCalledTimes(1);
    expect(encoders).toHaveBeenCalledTimes(1);
    sim.dispatch(1);
    expect(submits).toHaveBeenCalledTimes(2);
  } finally { gpu.dispose(); }
});

test("compute pass lifecycle guards, cancellation, and foreign devices", async () => {
  const gpu = await init();
  const foreign = await init();
  try {
    const sim = compute(gpu, EMPTY);
    const wrong = compute(foreign, EMPTY);
    const submits = vi.spyOn(gpu.gpu.queue, "submit");
    let saved!: FrameComputePass;
    const f = frame(gpu);
    f.computePass(p => {
      saved = p;
      expect(() => f.computePass(() => {})).toThrow(/active/i);
      expect(() => f.submit()).toThrow(/active/i);
      expect(() => f.cancel()).toThrow(/active/i);
      expect(() => p.dispatch(wrong, 1)).toThrow(/GPU device/);
      p.dispatch(sim, 1);
    });
    expect(() => saved.dispatch(sim, 1)).toThrow(/ended/);
    f.cancel();
    expect(() => f.computePass(() => {})).toThrow(/cancel/i);
    expect(submits).not.toHaveBeenCalled();
    expect(() => frame(gpu, f => f.computePass(async () => {}))).toThrow(/synchronous/);
    expect(() => frame(gpu, f => { f.computePass(p => p.dispatch(sim, 1)); throw new Error("abort"); })).toThrow("abort");
    expect(submits).not.toHaveBeenCalled();
  } finally { gpu.dispose(); foreign.dispose(); }
});

test("direct counts and literal workgroup limits fail before submission; zero is legal", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, EMPTY);
    const submit = vi.spyOn(gpu.gpu.queue, "submit");
    for (const count of [-1, 0.5, NaN, Infinity, 65536]) expect(() => sim.dispatch(count)).toThrow(/Dispatch x/);
    expect(submit).not.toHaveBeenCalled();
    expect(() => sim.dispatch(0)).not.toThrow();
    const large = compute(gpu, "@compute @workgroup_size(257) fn main() {}");
    expect(() => large.compileSync()).toThrow(/granted limit/);
    const product = compute(gpu, "@compute @workgroup_size(32, 32) fn main() {}");
    await expect(product.compile()).rejects.toMatchObject({ code: "VGPU-COMPILE-FAILED" });
  } finally { gpu.dispose(); }
});

test("managed uniform snapshots capture each revision and share unchanged values across pipelines", async () => {
  const gpu = await init();
  try {
    const shared = uniforms(gpu, { x: 1 });
    const shader = "struct U { x:f32 } @group(0) @binding(0) var<uniform> u: U; @compute @workgroup_size(1) fn main() { let x = u.x; }";
    const a = compute(gpu, shader, { set: { u: shared } });
    const b = compute(gpu, shader, { set: { u: shared } });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const f = frame(gpu);
    f.computePass(p => {
      p.dispatch(a, 1); p.dispatch(b, 1);
      shared.set({ x: 2 }); p.dispatch(a, 1);
    });
    f.submit();
    const bindings = mock.createBindGroupDescriptors.map(d => d.entries[Symbol.iterator]().next().value!.resource as GPUBufferBinding);
    const [first, same, changed] = bindings;
    expect(first!.buffer).toBe(same!.buffer);
    expect(first!.offset).toBe(same!.offset);
    expect(changed!.offset).not.toBe(first!.offset);
    const bytes = (first!.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(first!.offset!, true)).toBe(1);
    expect(view.getFloat32(changed!.offset!, true)).toBe(2);
    await f.done;
    const buffers = mock.calls.createBuffer;
    const next = frame(gpu, f => f.computePass(p => p.dispatch(a, 1)));
    expect(mock.calls.createBuffer).toBe(buffers);
    await next.done;
  } finally { gpu.dispose(); }
});

test("JS-owned uniform values are captured across draw and dispatch", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, UNIFORM, { set: { value: 1 } });
    const fx = effect(gpu, "@group(0) @binding(0) var<uniform> value:f32; @fragment fn main() -> @location(0) vec4f { return vec4f(value); }", { set: { value: 3 } });
    const color = target(gpu, { size: [2, 2] });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const f = frame(gpu, f => {
      f.computePass(p => { p.dispatch(sim, 1); sim.set({ value: 2 }); p.dispatch(sim, 1); });
      f.pass(color, p => { p.draw(fx); fx.set({ value: 4 }); p.draw(fx); });
    });
    const values = mock.createBindGroupDescriptors.map(d => {
      const binding = [...d.entries][0]!.resource as GPUBufferBinding;
      const bytes = (binding.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
      return new DataView(bytes.buffer).getFloat32(binding.offset ?? 0, true);
    });
    expect(values).toEqual([1, 2, 3, 4]);
    await f.done;
  } finally { gpu.dispose(); }
});

test("indirect buffers reject destruction and foreign ownership", async () => {
  const gpu = await init();
  const foreign = await init();
  try {
    const sim = compute(gpu, EMPTY);
    const args = storage(foreign, 12, { indirect: true });
    expect(() => sim.dispatch({ indirect: args })).toThrow(/different GPU/);
    const local = storage(gpu, 12, { indirect: true });
    (local as unknown as { destroy(): void }).destroy();
    expect(() => sim.dispatch({ indirect: local })).toThrow(/destroyed/);
  } finally { gpu.dispose(); foreign.dispose(); }
});

test("outstanding manual frames keep independent snapshots and cancel releases their pages", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, UNIFORM, { set: { value: 1 } });
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    const a = frame(gpu);
    a.computePass(p => p.dispatch(sim, 1));
    sim.set({ value: 2 });
    const b = frame(gpu);
    b.computePass(p => p.dispatch(sim, 1));
    const entries = mock.createBindGroupDescriptors.map(d => [...d.entries][0]!.resource as GPUBufferBinding);
    expect(entries[0]!.buffer).not.toBe(entries[1]!.buffer);
    b.submit();
    a.submit();
    await Promise.all([a.done, b.done]);
    for (const [index, entry] of entries.entries()) {
      const bytes = (entry.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
      expect(new DataView(bytes.buffer).getFloat32(entry.offset ?? 0, true)).toBe(index + 1);
    }
    const allocations = mock.calls.createBuffer;
    const canceled = frame(gpu);
    canceled.computePass(p => p.dispatch(sim, 1));
    canceled.cancel();
    const next = frame(gpu, f => f.computePass(p => p.dispatch(sim, 1)));
    expect(mock.calls.createBuffer).toBe(allocations);
    await next.done;
  } finally { gpu.dispose(); }
});

test("frame.done remains resolve-only if submitted work completion rejects", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, UNIFORM, { set: { value: 1 } });
    const errors: unknown[] = [];
    gpu.onError(e => errors.push(e));
    gpu.gpu.queue.onSubmittedWorkDone = () => Promise.reject(new Error("lost device"));
    const f = frame(gpu, f => f.computePass(p => p.dispatch(sim, 1)));
    await expect(f.done).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  } finally { gpu.dispose(); }
});

test("compute cache keys include constants and constructor options are snapshotted", async () => {
  const gpu = await init();
  try {
    const shader = "override WG:u32=1; @compute @workgroup_size(WG) fn main() {}";
    const constants = { WG: 2 };
    const a = compute(gpu, shader, { constants });
    constants.WG = 4;
    const b = compute(gpu, shader, { constants: { WG: 2 } });
    const c = compute(gpu, shader, { constants });
    await Promise.all([a.compile(), b.compile(), c.compile()]);
    const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
    expect(mock.calls.createComputePipelineAsync).toBe(2);
    expect(mock.createComputePipelineAsyncDescriptors.map(d => d.compute.constants)).toEqual([{ WG: 2 }, { WG: 4 }]);
  } finally { gpu.dispose(); }
});

test("workgroup preflight uses restricted device limits rather than core defaults", async () => {
  const gpu = await init();
  try {
    Object.defineProperty(gpu.gpu.limits, "maxComputeWorkgroupSizeX", { value: 128 });
    Object.defineProperty(gpu.gpu.limits, "maxComputeInvocationsPerWorkgroup", { value: 128 });
    const invalid = compute(gpu, "@compute @workgroup_size(256) fn main() {}");
    expect(() => invalid.compileSync()).toThrow(/granted limit is 128/);
    const valid = compute(gpu, "@compute @workgroup_size(128) fn main() {}");
    await expect(valid.compile()).resolves.toBe(valid);
  } finally { gpu.dispose(); }
});

import { expect, test, vi } from "vitest";
import { compute, init } from "../../src/mock.ts";
const SHADER = "@compute @workgroup_size(1) fn main() {}";

function scopes(device: GPUDevice) {
  const pending: ((error: GPUError | null) => void)[] = [];
  device.pushErrorScope = vi.fn();
  device.popErrorScope = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  return pending;
}

test("compile after compileSync waits for validation and rejects the invalid candidate", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, SHADER);
    const pending = scopes(gpu.gpu);
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    sim.compileSync();
    let done = false;
    const compiling = sim.compile().finally(() => { done = true; });
    const rejected = expect(compiling).rejects.toMatchObject({ code: "VGPU-COMPILE-FAILED" });
    await Promise.resolve();
    expect(done).toBe(false);
    pending.shift()!({ message: "invalid pipeline" } as GPUError);
    await rejected;
    await gpu.settled();
    expect(errors).toHaveLength(1);
    expect(() => sim.dispatch(1)).toThrow(/compilation failed/);
    const retry = sim.compile();
    pending.splice(0).forEach(resolve => resolve(null));
    await expect(retry).resolves.toBe(sim);
  } finally { gpu.dispose(); }
});

test("sync takeover cannot settle async preparation before validation", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, SHADER);
    let rejectNative!: (error: Error) => void;
    gpu.gpu.createComputePipelineAsync = () => new Promise((_resolve, reject) => { rejectNative = reject; });
    const pending = scopes(gpu.gpu);
    const compilation = sim.compile();
    sim.compileSync();
    let done = false;
    void compilation.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    pending[1]!(null);
    await expect(compilation).resolves.toBe(sim);
    rejectNative(new Error("superseded"));
    pending[0]!(null);
    await gpu.settled();
  } finally { gpu.dispose(); }
});

test("explicit async failure belongs to the promise, not onError", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, SHADER);
    const errors: unknown[] = [];
    gpu.onError(e => errors.push(e));
    gpu.gpu.createComputePipelineAsync = () => Promise.reject(new Error("native validation"));
    await expect(sim.compile()).rejects.toMatchObject({ code: "VGPU-COMPILE-FAILED" });
    await gpu.settled();
    expect(errors).toEqual([]);
  } finally { gpu.dispose(); }
});

test("dispose rejects pending compilation even if native creation never settles", async () => {
  const gpu = await init();
  const sim = compute(gpu, SHADER);
  gpu.gpu.createComputePipelineAsync = () => new Promise(() => {});
  const rejected = expect(sim.compile()).rejects.toMatchObject({ code: "VGPU-COMPILE-DISPOSED" });
  gpu.dispose();
  await rejected;
  await expect(gpu.settled()).resolves.toBeUndefined();
});

test.each([0, 1, 2, 3, 4])("standalone native validation phase %i is delivered once and joins settled", async phase => {
  const gpu = await init();
  try {
    const sim = compute(gpu, SHADER);
    await sim.compile();
    const pending = scopes(gpu.gpu);
    const errors: unknown[] = [];
    gpu.onError(e => errors.push(e));
    sim.dispatch(1);
    expect(pending).toHaveLength(5); // begin, dispatch, end, finish, submit
    let settled = false;
    const waiting = gpu.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.forEach((resolve, index) => resolve(index === phase ? { message: `phase ${phase}` } as GPUError : null));
    await waiting;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "VGPU-COMPUTE-VALIDATION" });
  } finally { gpu.dispose(); }
});

test("disposal rejects compile awaiting an unresolved synchronous candidate", async () => {
  const gpu = await init();
  const sim = compute(gpu, SHADER);
  scopes(gpu.gpu);
  sim.compileSync();
  const rejection = expect(sim.compile()).rejects.toMatchObject({ code: "VGPU-COMPILE-DISPOSED" });
  gpu.dispose();
  await rejection;
  await gpu.settled();
});

test("unconsumed shader creation failures reach onError and settled", async () => {
  const gpu = await init();
  try {
    const pending = scopes(gpu.gpu);
    const errors: unknown[] = [];
    gpu.onError(e => errors.push(e));
    compute(gpu, SHADER);
    // No bindings: pipeline layout then shader module, without a compute pipeline.
    pending.forEach((resolve, index) => resolve(index === pending.length - 1 ? { message: "shader creation failed" } as GPUError : null));
    await gpu.settled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "VGPU-COMPILE-FAILED", where: "compute.shader" });
  } finally { gpu.dispose(); }
});

test("deferred pass-end errors do not duplicate the originating pipeline failure", async () => {
  const gpu = await init();
  try {
    const sim = compute(gpu, SHADER);
    const pending = scopes(gpu.gpu);
    const errors: unknown[] = [];
    gpu.onError(e => errors.push(e));
    sim.compileSync();
    sim.dispatch(1);
    // The dispatch scope is clean; Dawn reports the poisoned pipeline at pass end.
    pending.forEach((resolve, index) => resolve(index === 0 || index >= 3 ? { message: "invalid pipeline" } as GPUError : null));
    await gpu.settled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "VGPU-COMPILE-FAILED" });
  } finally { gpu.dispose(); }
});

test("a cached compile cannot resolve to a device disposed before promise delivery", async () => {
  const gpu = await init();
  const sim = compute(gpu, SHADER);
  await sim.compile();
  const pending = sim.compile();
  gpu.dispose();
  await expect(pending).rejects.toMatchObject({ code: "VGPU-DEVICE-DISPOSED" });
});

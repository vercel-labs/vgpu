import { expect, test, vi } from "vitest";
import { createMockGPUDevice, Device } from "@vgpu/core";
import { createQueryRing } from "../src/query-ring.ts";

interface ControlledMaps {
  readonly device: Device;
  /** One resolver per started staging mapAsync, in start order. */
  readonly resolvers: Array<() => void>;
}

/** Mock device whose staging-buffer mapAsync promises resolve only when the test says so. */
function createControlledDevice(): ControlledMaps {
  const gpu = createMockGPUDevice();
  const resolvers: Array<() => void> = [];
  const originalCreateBuffer = gpu.createBuffer.bind(gpu);
  vi.spyOn(gpu, "createBuffer").mockImplementation((descriptor: GPUBufferDescriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    if (descriptor.label?.includes("staging")) {
      (buffer as { mapAsync: GPUBuffer["mapAsync"] }).mapAsync = () => new Promise<undefined>((resolve) => { resolvers.push(() => resolve(undefined)); });
    }
    return buffer;
  });
  return { device: new Device(gpu), resolvers };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("encodeResolve resolves the contiguous used range and copies into the rotating staging buffer", () => {
  const { device } = createControlledDevice();
  const ring = createQueryRing(device, { type: "timestamp", capacity: 8, label: "ring" });
  const ops: Array<readonly unknown[]> = [];
  const wrapped = {
    resolveQuerySet: (...args: unknown[]) => { ops.push(["resolveQuerySet", args[1], args[2], args[4]]); },
    copyBufferToBuffer: (...args: unknown[]) => { ops.push(["copyBufferToBuffer", args[1], args[3], args[4]]); },
  } as unknown as GPUCommandEncoder;

  expect(ring.encodeResolve(wrapped, 0)).toBe(false);
  expect(ring.encodeResolve(wrapped, 6)).toBe(true);
  expect(ops).toEqual([
    ["resolveQuerySet", 0, 6, 0],
    ["copyBufferToBuffer", 0, 0, 6 * 8],
  ]);
  expect(ring.querySet.type).toBe("timestamp");
  expect(ring.capacity).toBe(8);
  ring.dispose();
  vi.restoreAllMocks();
});

test("readbacks decode the staged u64 values and skip resolving while all staging buffers are map-pending", async () => {
  const { device, resolvers } = createControlledDevice();
  const ring = createQueryRing(device, { type: "timestamp", capacity: 8, label: "ring", depth: 2 });
  const applied: BigUint64Array[] = [];
  const encoder = device.gpu.createCommandEncoder();

  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.onSubmitted((values) => applied.push(values));
  expect(ring.encodeResolve(encoder, 4)).toBe(true);
  ring.onSubmitted((values) => applied.push(values));
  // Depth 2 and both staging buffers map-pending: drop the frame's resolve entirely, never block.
  expect(ring.encodeResolve(encoder, 2)).toBe(false);
  ring.onSubmitted(() => { throw new Error("skipped resolves must not read back"); });

  resolvers[0]!();
  resolvers[1]!();
  await flushMicrotasks();
  // Mock fake value for query i is i*i * 1e6.
  expect(applied.map((values) => [...values])).toEqual([
    [0n, 1_000_000n],
    [0n, 1_000_000n, 4_000_000n, 9_000_000n],
  ]);
  // With a staging buffer free again, resolving resumes.
  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.dispose();
  vi.restoreAllMocks();
});

test("a stale readback that lands after a newer one is discarded", async () => {
  const { device, resolvers } = createControlledDevice();
  const ring = createQueryRing(device, { type: "timestamp", capacity: 8, label: "ring", depth: 3 });
  const applied: number[] = [];
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted((values) => applied.push(values.length));
  ring.encodeResolve(encoder, 4);
  ring.onSubmitted((values) => applied.push(values.length));

  // The newer readback lands first; the older one lands afterwards and must be discarded.
  resolvers[1]!();
  await flushMicrotasks();
  resolvers[0]!();
  await flushMicrotasks();

  expect(applied).toEqual([4]);
  ring.dispose();
  vi.restoreAllMocks();
});

test("dispose defers destruction until in-flight readbacks settle and still applies them", async () => {
  const { device, resolvers } = createControlledDevice();
  const destroyed: string[] = [];
  const originalCreateQuerySet = device.gpu.createQuerySet.bind(device.gpu);
  vi.spyOn(device.gpu, "createQuerySet").mockImplementation((descriptor: GPUQuerySetDescriptor) => {
    const querySet = originalCreateQuerySet(descriptor);
    const originalDestroy = querySet.destroy.bind(querySet);
    querySet.destroy = () => { destroyed.push("querySet"); originalDestroy(); };
    return querySet;
  });
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring" });
  const applied: number[] = [];
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted((values) => applied.push(values.length));
  ring.dispose();
  // A consumer retiring a ring (capacity growth) must not lose results already submitted.
  expect(destroyed).toEqual([]);
  resolvers[0]!();
  await flushMicrotasks();
  expect(applied).toEqual([2]);
  expect(destroyed).toEqual(["querySet"]);
  // Disposed rings refuse new work.
  expect(ring.encodeResolve(encoder, 2)).toBe(false);
  vi.restoreAllMocks();
});

test("pending readbacks register with trackSettled so gpu.settled() covers them", async () => {
  const { device, resolvers } = createControlledDevice();
  const tracked: Promise<unknown>[] = [];
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring", trackSettled: (promise) => tracked.push(promise) });
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted(() => undefined);
  expect(tracked).toHaveLength(1);
  let settled = false;
  void tracked[0]!.then(() => { settled = true; });
  await flushMicrotasks();
  expect(settled).toBe(false);
  resolvers[0]!();
  await flushMicrotasks();
  expect(settled).toBe(true);
  ring.dispose();
  vi.restoreAllMocks();
});

test("a failed readback is dropped but reported on the errorSink instead of being swallowed", async () => {
  const gpu = createMockGPUDevice();
  const rejections: Array<(reason: unknown) => void> = [];
  const originalCreateBuffer = gpu.createBuffer.bind(gpu);
  vi.spyOn(gpu, "createBuffer").mockImplementation((descriptor: GPUBufferDescriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    if (descriptor.label?.includes("staging")) {
      (buffer as { mapAsync: GPUBuffer["mapAsync"] }).mapAsync = () => new Promise<undefined>((_resolve, reject) => { rejections.push(reject); });
    }
    return buffer;
  });
  const device = new Device(gpu);
  const errors: Array<{ code: string; message: string }> = [];
  const tracked: Promise<unknown>[] = [];
  const ring = createQueryRing(device, {
    type: "timestamp",
    capacity: 4,
    label: "vgpu.timer",
    errorSink: (error) => { errors.push(error); },
    trackSettled: (promise) => tracked.push(promise),
  });
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted(() => { throw new Error("a failed readback must not apply"); });
  rejections[0]!(new Error("device lost"));
  await flushMicrotasks();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "VGPU-QUERY-READBACK", message: expect.stringContaining("device lost") });
  expect(errors[0]!.message).toContain("vgpu.timer");
  // Non-throwing contract: the tracked readback settles instead of rejecting gpu.settled().
  await expect(tracked[0]!).resolves.toBeUndefined();
  // The staging slot is released again, so the next frame still resolves.
  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.dispose();
  vi.restoreAllMocks();
});

test("dispose() defers destruction while a frame retains the ring, then destroys on release", async () => {
  const { device } = createControlledDevice();
  const destroyed: string[] = [];
  const originalCreateQuerySet = device.gpu.createQuerySet.bind(device.gpu);
  vi.spyOn(device.gpu, "createQuerySet").mockImplementation((descriptor: GPUQuerySetDescriptor) => {
    const querySet = originalCreateQuerySet(descriptor);
    const originalDestroy = querySet.destroy.bind(querySet);
    querySet.destroy = () => { destroyed.push("querySet"); originalDestroy(); };
    return querySet;
  });
  const ring = createQueryRing(device, { type: "occlusion", capacity: 4, label: "ring" });

  // A frame bound querySet into a pass descriptor: dispose() must not destroy it mid-frame.
  ring.retain();
  ring.dispose();
  expect(destroyed).toEqual([]);
  // The frame was submitted: nothing references the set anymore.
  ring.release();
  expect(destroyed).toEqual(["querySet"]);
  // Balanced release()es never double-destroy.
  ring.release();
  expect(destroyed).toEqual(["querySet"]);
  vi.restoreAllMocks();
});

interface StagingFault {
  /** getMappedRange throws — the buffer stays mapped. */
  mapRange?: boolean;
  /** unmap throws — the buffer may stay mapped forever. */
  unmap?: boolean;
}

/**
 * Mock device whose staging buffers fail on the mapped path, per staging index. The fault objects
 * are read at call time, so a test can clear one to make the failure a one-shot.
 */
function createFaultyDevice(faults: Record<number, StagingFault>): { device: Device; unmaps: number[] } {
  const gpu = createMockGPUDevice();
  const unmaps: number[] = [];
  const originalCreateBuffer = gpu.createBuffer.bind(gpu);
  vi.spyOn(gpu, "createBuffer").mockImplementation((descriptor: GPUBufferDescriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    const index = Number(/staging(\d+)$/.exec(descriptor.label ?? "")?.[1] ?? NaN);
    if (Number.isInteger(index)) {
      const fault = faults[index];
      const originalRange = buffer.getMappedRange.bind(buffer);
      const originalUnmap = buffer.unmap.bind(buffer);
      buffer.getMappedRange = (...args: Parameters<GPUBuffer["getMappedRange"]>) => {
        if (fault?.mapRange) throw new Error(`getMappedRange failed on staging${index}`);
        return originalRange(...args);
      };
      buffer.unmap = () => {
        unmaps.push(index);
        if (fault?.unmap) throw new Error(`unmap failed on staging${index}`);
        originalUnmap();
      };
    }
    return buffer;
  });
  return { device: new Device(gpu), unmaps };
}

test("a post-map failure whose unmap succeeds reports the drop and keeps the staging buffer in rotation", async () => {
  const faults: Record<number, StagingFault> = { 0: { mapRange: true } };
  const { device, unmaps } = createFaultyDevice(faults);
  const errors: Array<{ code: string }> = [];
  // Depth 1: the same staging buffer must be reused, so a slot wrongly left mapped would be caught here.
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring", depth: 1, errorSink: (error) => { errors.push(error); } });
  const applied: number[] = [];
  const encoder = device.gpu.createCommandEncoder();

  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.onSubmitted(() => { throw new Error("a failed decode must not apply"); });
  await flushMicrotasks();

  expect(errors.map((error) => error.code)).toEqual(["VGPU-QUERY-READBACK"]);
  // The best-effort unmap ran, so the buffer is unmapped and safe to resolve into again.
  expect(unmaps).toEqual([0]);
  faults[0]!.mapRange = false; // the device recovers; the slot must still be usable
  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.onSubmitted((values) => applied.push(values.length));
  await flushMicrotasks();
  expect(applied).toEqual([2]);
  expect(errors).toHaveLength(1);
  ring.dispose();
  vi.restoreAllMocks();
});

test("a post-map failure whose unmap also fails retires the staging buffer instead of resolving into a mapped one", async () => {
  const { device } = createFaultyDevice({ 0: { mapRange: true, unmap: true } });
  const errors: Array<{ code: string }> = [];
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring", depth: 1, errorSink: (error) => { errors.push(error); } });
  const encoder = device.gpu.createCommandEncoder();

  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.onSubmitted(() => { throw new Error("a failed decode must not apply"); });
  await flushMicrotasks();

  expect(errors.map((error) => error.code)).toEqual(["VGPU-QUERY-READBACK"]);
  // The only staging buffer may still be mapped: copying into it would be a validation error, so the
  // ring drops readbacks (reported, never silent) rather than reusing the slot.
  expect(ring.encodeResolve(encoder, 2)).toBe(false);
  expect(ring.encodeResolve(encoder, 2)).toBe(false);
  ring.dispose();
  vi.restoreAllMocks();
});

test("a retired staging buffer is rotated past: the remaining buffers keep serving readbacks", async () => {
  const { device } = createFaultyDevice({ 0: { mapRange: true, unmap: true } });
  const errors: Array<{ code: string }> = [];
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring", depth: 2, errorSink: (error) => { errors.push(error); } });
  const applied: number[] = [];
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted(() => { throw new Error("a failed decode must not apply"); });
  await flushMicrotasks();
  expect(errors).toHaveLength(1);

  // staging1 is healthy: two more frames read back through it (the retired staging0 is skipped).
  expect(ring.encodeResolve(encoder, 2)).toBe(true);
  ring.onSubmitted((values) => applied.push(values.length));
  await flushMicrotasks();
  expect(ring.encodeResolve(encoder, 3)).toBe(true);
  ring.onSubmitted((values) => applied.push(values.length));
  await flushMicrotasks();

  expect(applied).toEqual([2, 3]);
  expect(errors).toHaveLength(1);
  ring.dispose();
  vi.restoreAllMocks();
});

test("an unmap that fails after a successful decode drops that readback and retires the slot", async () => {
  const { device, unmaps } = createFaultyDevice({ 0: { unmap: true } });
  const errors: Array<{ code: string; message: string }> = [];
  const ring = createQueryRing(device, { type: "timestamp", capacity: 4, label: "ring", depth: 1, errorSink: (error) => { errors.push(error); } });
  const encoder = device.gpu.createCommandEncoder();

  ring.encodeResolve(encoder, 2);
  ring.onSubmitted(() => { throw new Error("a readback with a failed unmap must not apply"); });
  await flushMicrotasks();

  expect(unmaps).toEqual([0]);
  expect(errors[0]).toMatchObject({ code: "VGPU-QUERY-READBACK", message: expect.stringContaining("unmap failed on staging0") });
  expect(ring.encodeResolve(encoder, 2)).toBe(false);
  ring.dispose();
  vi.restoreAllMocks();
});

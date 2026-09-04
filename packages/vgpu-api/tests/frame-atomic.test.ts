import { afterEach, expect, test, vi } from "vitest";
import { createMockAdapter, init, effect, frame, target, timer, visibility } from "../src/mock.ts";
import { Frame } from "../src/frame.ts";

// `frame(gpu, cb)` is atomic with respect to its command buffer: a callback that returns submits
// once, a callback that throws submits nothing. Only the frame's own command buffer is covered —
// the clock tick, CPU-side mutations and independent submissions are never rolled back.

afterEach(() => { vi.restoreAllMocks(); });

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

test("a callback that returns submits exactly once", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => {
    currentFrame.pass(colorTarget, () => undefined);
    currentFrame.pass(colorTarget, () => undefined);
  });
  await gpu.settled();

  expect(submits.count).toBe(1);
  gpu.dispose();
});

test("a callback that throws before encoding submits nothing and rethrows the same error object", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const failure = new Error("scene not ready");

  let thrown: unknown;
  try { frame(gpu, () => { throw failure; }); }
  catch (error) { thrown = error; }
  await gpu.settled();

  expect(thrown).toBe(failure);
  expect(submits.count).toBe(0);
  gpu.dispose();
});

test("a callback that encodes passes and then throws submits nothing", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const ops = spyFrameEncoders(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
  const failure = new Error("second pass setup failed");

  let thrown: unknown;
  try {
    frame(gpu, (currentFrame) => {
      currentFrame.pass(colorTarget, shader);
      currentFrame.pass(colorTarget, shader);
      throw failure;
    });
  } catch (error) { thrown = error; }
  await gpu.settled();

  expect(thrown).toBe(failure);
  expect(submits.count).toBe(0);
  // The encoder was dropped, never finished: nothing it recorded can reach the queue later.
  expect(ops.encodeOps).toEqual([]);
  gpu.dispose();
});

test("a throwing callback releases every timer and visibility retain the frame took", async () => {
  const gpu = await initWithTimestampQuery();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => p.occlusion(query, () => undefined));
    gpuTimer.dispose();
    vis.dispose();
    // Both query sets are referenced by the encoded pass: destruction waits for the frame to close.
    expect(destroyed).toEqual([]);
    throw new Error("frame abandoned");
  })).toThrowError(/frame abandoned/);
  await gpu.settled();

  // The cancel released both retains, and nothing was read back for the dropped frame.
  expect(submits.count).toBe(0);
  expect([...destroyed].sort()).toEqual([0, 1]);
  expect(results).toEqual([]);
  expect(query.state).toBe("unknown");
  gpu.dispose();
});

test("a callback that submits explicitly and then throws keeps that one submit and rethrows the original error", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const cancels = vi.spyOn(Frame.prototype, "cancel");
  const colorTarget = target(gpu, { size: [4, 4] });
  const failure = new Error("post-submit bookkeeping failed");

  let thrown: unknown;
  try {
    frame(gpu, (currentFrame) => {
      currentFrame.pass(colorTarget, () => undefined);
      currentFrame.submit(); // work is on the queue: it cannot be taken back
      throw failure;
    });
  } catch (error) { thrown = error; }
  await gpu.settled();

  // The runner sees a closed frame and does not even ask cancel(): a VGPU-FRAME-SUBMITTED from an
  // attempted cancel, swallowed or not, is never part of this path.
  expect(thrown).toBe(failure);
  expect(submits.count).toBe(1);
  expect(cancels).not.toHaveBeenCalled();
  gpu.dispose();
});

test("a callback that cancels and then throws submits nothing and rethrows the original error", async () => {
  const gpu = await initWithTimestampQuery();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const cancels = vi.spyOn(Frame.prototype, "cancel");
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const failure = new Error("stale frame");

  let thrown: unknown;
  try {
    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => undefined);
      currentFrame.cancel();
      throw failure;
    });
  } catch (error) { thrown = error; }
  await gpu.settled();

  expect(thrown).toBe(failure);
  expect(submits.count).toBe(0);
  expect(results).toEqual([]);
  // The callback's own cancel() closed the frame; the runner did not cancel it a second time.
  expect(cancels).toHaveBeenCalledTimes(1);
  gpuTimer.dispose();
  gpu.dispose();
});

test("a non-Error throwable is rethrown by identity too", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const failure = { reason: "not an Error instance" };

  let thrown: unknown;
  try {
    frame(gpu, (currentFrame) => {
      currentFrame.pass(colorTarget, () => undefined);
      throw failure;
    });
  } catch (error) { thrown = error; }
  await gpu.settled();

  expect(thrown).toBe(failure);
  expect(submits.count).toBe(0);
  gpu.dispose();
});

test("the done promise of a frame canceled by a throw still resolves", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  let opened: Frame | undefined;

  expect(() => frame(gpu, (currentFrame) => {
    opened = currentFrame;
    currentFrame.pass(colorTarget, () => undefined);
    throw new Error("abandoned");
  })).toThrowError(/abandoned/);

  // Nothing was submitted, so there is nothing to wait for: awaiting a canceled frame never hangs.
  await expect(opened?.done).resolves.toBeUndefined();
  gpu.dispose();
});

test("gpu.dispose() inside the callback keeps its cleanup, whether the callback returns or throws", async () => {
  const returning = await init();
  const returningSubmits = spyQueueSubmits(returning.device.gpu);
  const returningTarget = target(returning, { size: [4, 4] });
  let returned: Frame | undefined;
  expect(() => {
    returned = frame(returning, (currentFrame) => {
      currentFrame.pass(returningTarget, () => undefined);
      returning.dispose(); // cancels the open frame through the scheduler phase
    });
  }).not.toThrow();
  // dispose() canceled the frame and took the device: the implicit submit found a closed frame,
  // and the frame stays closed rather than being reopened or resubmitted by the runner.
  expect(returningSubmits.count).toBe(0);
  expect(() => returned?.pass(returningTarget, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-FRAME-CANCELED" }));
  expect(() => frame(returning, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED" }));

  const throwing = await init();
  const throwingSubmits = spyQueueSubmits(throwing.device.gpu);
  const throwingTarget = target(throwing, { size: [4, 4] });
  const failure = new Error("torn down mid-frame");
  let opened: Frame | undefined;
  let thrown: unknown;
  try {
    frame(throwing, (currentFrame) => {
      opened = currentFrame;
      currentFrame.pass(throwingTarget, () => undefined);
      throwing.dispose();
      throw failure;
    });
  } catch (error) { thrown = error; }
  // Same cleanup, and the callback's error is still the one that comes out.
  expect(thrown).toBe(failure);
  expect(throwingSubmits.count).toBe(0);
  expect(() => opened?.pass(throwingTarget, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-FRAME-CANCELED" }));
  expect(() => frame(throwing, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED" }));
});

test("manual frames still need an explicit submit() or cancel()", async () => {
  const gpu = await initWithTimestampQuery();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  const manual = frame(gpu);
  manual.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => undefined);
  gpuTimer.dispose();
  await gpu.settled();
  // Nothing closes a manual frame for you: no submit happened and the retain is still held.
  expect(submits.count).toBe(0);
  expect(destroyed).toEqual([]);

  manual.submit();
  expect(submits.count).toBe(1);
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
});

/** Counts command buffers handed to the queue, matching the "nothing reached the GPU" assertions. */
function spyQueueSubmits(device: GPUDevice): { readonly count: number } {
  const counter = { count: 0 };
  const original = device.queue.submit.bind(device.queue);
  vi.spyOn(device.queue, "submit").mockImplementation((buffers: Iterable<GPUCommandBuffer>) => {
    counter.count += 1;
    original(buffers);
  });
  return counter;
}

/** Records the creation index of every query set destroyed, matching frame-cancel.test.ts. */
function spyQuerySetDestroys(device: GPUDevice, destroyed: number[]): void {
  let created = 0;
  const originalCreateQuerySet = device.createQuerySet.bind(device);
  vi.spyOn(device, "createQuerySet").mockImplementation((descriptor: GPUQuerySetDescriptor) => {
    const querySet = originalCreateQuerySet(descriptor);
    const index = created++;
    const originalDestroy = querySet.destroy.bind(querySet);
    querySet.destroy = () => { destroyed.push(index); originalDestroy(); };
    return querySet;
  });
}

type EncodeOp = readonly [name: string, ...args: unknown[]];

/** Captures resolve/copy/finish ordering on vgpu.frame encoders, matching frame-cancel.test.ts. */
function spyFrameEncoders(device: GPUDevice): { readonly encodeOps: EncodeOp[] } {
  const encodeOps: EncodeOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    if (descriptor?.label !== "vgpu.frame") return encoder;
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        return encoder.beginRenderPass(renderPassDescriptor);
      },
      resolveQuerySet(querySet: GPUQuerySet, firstQuery: number, queryCount: number, destination: GPUBuffer, destinationOffset: number) {
        encodeOps.push(["resolveQuerySet", firstQuery, queryCount]);
        encoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset);
      },
      copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size?: number) {
        encodeOps.push(["copyBufferToBuffer", size]);
        encoder.copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size);
      },
      finish(finishDescriptor?: GPUCommandBufferDescriptor) {
        encodeOps.push(["finish"]);
        return encoder.finish(finishDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return { encodeOps };
}

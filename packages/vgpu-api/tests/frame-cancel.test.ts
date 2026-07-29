import { expect, test, vi } from "vitest";
import { createMockAdapter, init, effect, frame, target, timer, visibility } from "../src/mock.ts";
import type { FramePass } from "../src/frame.ts";

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

test("cancel() releases every telemetry retain the frame took", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });

  const currentFrame = frame(gpu);
  currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => p.occlusion(vis.query("statue"), () => undefined));
  gpuTimer.dispose();
  vis.dispose();
  // Both query sets are referenced by the open frame's pass descriptor: destruction is deferred.
  expect(destroyed).toEqual([]);

  currentFrame.cancel();

  // Without cancel() this frame would hold both rings until gpu.dispose() — it may still be submitted.
  expect([...destroyed].sort()).toEqual([0, 1]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("cancel() submits nothing and reports no phantom telemetry", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const submits = spyQueueSubmits(gpu.device.gpu);
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue"); // slot 0 reads back the mock's fake value 0 -> a phantom "hidden"

  const currentFrame = frame(gpu);
  currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => p.occlusion(query, () => undefined));
  currentFrame.cancel();
  await gpu.settled();

  // No resolve is encoded, the encoder is never finished, and nothing reaches the queue.
  expect(ops.encodeOps).toEqual([]);
  expect(submits.count).toBe(0);
  expect(results).toEqual([]);
  expect(query.state).toBe("unknown");
  expect(query.hidden).toBe(false);
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("cancel() is idempotent and submit() after cancel() is a no-op", async () => {
  const gpu = await initWithTimestampQuery();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  const currentFrame = frame(gpu);
  currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => undefined);
  currentFrame.cancel();
  expect(() => currentFrame.cancel()).not.toThrow();
  // submit() treats a closed frame as "nothing left to flush", exactly like a repeated submit().
  expect(() => currentFrame.submit()).not.toThrow();
  await gpu.settled();

  expect(submits.count).toBe(0);
  expect(results).toEqual([]);
  gpuTimer.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("cancel() after submit() throws VGPU-FRAME-SUBMITTED", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  const currentFrame = frame(gpu);
  currentFrame.pass(colorTarget, () => undefined);
  currentFrame.submit();

  expect(() => currentFrame.cancel()).toThrowError(/already submitted/);
  try { currentFrame.cancel(); }
  catch (error) { expect(error).toMatchObject({ code: "VGPU-FRAME-SUBMITTED", where: "Frame.cancel" }); }
  await gpu.settled();
  gpu.dispose();
});

test("pass() after cancel() throws VGPU-FRAME-CANCELED", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });

  const currentFrame = frame(gpu);
  currentFrame.cancel();

  expect(() => currentFrame.pass(colorTarget, () => undefined)).toThrowError(/canceled/);
  try { currentFrame.pass(colorTarget, () => undefined); }
  catch (error) { expect(error).toMatchObject({ code: "VGPU-FRAME-CANCELED", where: "Frame.pass" }); }
  gpu.dispose();
});

test("cancel() rejects while a pass callback is active and keeps descriptor resources retained", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const currentFrame = frame(gpu);

  currentFrame.pass({ target: scene, visibility: vis }, () => {
    vis.dispose();
    expect(() => currentFrame.cancel()).toThrowError(/pass callback is active/);
    try { currentFrame.cancel(); }
    catch (error) { expect(error).toMatchObject({ code: "VGPU-FRAME-PASS-ACTIVE", where: "Frame.cancel" }); }
    // The active native pass descriptor still owns this query set, so cancel must not release it.
    expect(destroyed).toEqual([]);
  });

  currentFrame.cancel();
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a FramePass retained by user code cannot encode after its frame is canceled", async () => {
  const gpu = await init();
  const scene = target(gpu, { size: [4, 4], depth: true });
  const vis = visibility(gpu);
  const query = vis.query("statue");
  const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
  const currentFrame = frame(gpu);
  let stalePass: FramePass | undefined;

  currentFrame.pass({ target: scene, visibility: vis }, (pass) => { stalePass = pass; });
  currentFrame.cancel();

  expect(() => stalePass?.draw(shader)).toThrowError(/frame was canceled/);
  expect(() => stalePass?.occlusion(query, () => undefined)).toThrowError(/frame was canceled/);
  vis.dispose();
  gpu.dispose();
});

test("cancel() inside frame(gpu, cb) leaves the submit in finally a no-op", async () => {
  const gpu = await initWithTimestampQuery();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => undefined);
    currentFrame.cancel(); // e.g. the app noticed the frame is stale before it reached the queue
  });
  await gpu.settled();

  expect(submits.count).toBe(0);
  expect(results).toEqual([]);
  gpuTimer.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a canceled frame leaves the telemetry usable on the next frame", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  const canceled = frame(gpu);
  canceled.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => p.occlusion(query, () => undefined));
  canceled.cancel();
  await gpu.settled();
  expect(results).toEqual([]);

  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(query, () => undefined);
  }));
  await gpu.settled();

  // Mock fake timestamp for query i is i*i * 1e6 ns: the pair (0, 1) decodes to 1 ms.
  expect(results).toEqual([{ main: 1 }]);
  expect(query.state).toBe("hidden"); // slot 0 -> mock fake value 0
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
});

test("cancelling one open frame keeps the other open frame's retain", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  const first = frame(gpu);
  first.pass({ target: colorTarget, timer: gpuTimer.span("first") }, () => undefined);
  const second = frame(gpu);
  second.pass({ target: colorTarget, timer: gpuTimer.span("second") }, () => undefined);
  gpuTimer.dispose();
  expect(destroyed).toEqual([]);

  first.cancel();
  // The second frame still encodes against the same query set: its retain outlives the cancel.
  expect(destroyed).toEqual([]);
  second.submit();
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
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

/** Records the creation index of every query set destroyed, matching timer.test.ts / visibility.test.ts. */
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

/** Captures resolve/copy/finish ordering on vgpu.frame encoders, matching pass-telemetry-rollback.test.ts. */
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

test("gpu.dispose cancels outstanding manual frames before resource teardown", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [1, 1] });
  const manual = frame(gpu);
  gpu.dispose();
  expect(() => manual.pass(colorTarget, () => undefined)).toThrowError(/frame was canceled/);
  manual.submit();
});

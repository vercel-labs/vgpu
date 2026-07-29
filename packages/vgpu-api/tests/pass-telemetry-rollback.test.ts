import { expect, test, vi } from "vitest";
import { createMockAdapter, init, draw, frame, target, timer, visibility } from "../src/mock.ts";

const SOLID = `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`;

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

test("a throwing pass callback leaves no phantom timer result", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => {
    throw new Error("draw setup failed");
  }))).toThrowError(/draw setup failed/);
  await gpu.settled();

  // The pass never encoded its draws, so its timing is meaningless: the frame's telemetry is
  // dropped instead of resolved/read back as if the pass had run.
  expect(results).toEqual([]);
  expect(ops.encodeOps).toEqual([["finish"]]);
  gpuTimer.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a pass setup failure after attaching a timer leaves no phantom result", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const colorOnly = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  // Timer attachment succeeds first; visibility validation then fails before beginRenderPass.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorOnly, timer: gpuTimer.span("main"), visibility: vis }, () => undefined)))
    .toThrowError(/no depth attachment/);
  await gpu.settled();

  expect(results).toEqual([]);
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
});

test("a timer validation failure after an earlier pass drops the frame's partial result", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("duplicate") }, () => undefined);
    currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("duplicate") }, () => undefined);
  })).toThrowError(/duplicate span|VGPU-TIMER-INVALID/);
  await gpu.settled();

  expect(results).toEqual([]);
  gpuTimer.dispose();
  gpu.dispose();
});

test("a failed attach drops every telemetry instance of that frame, not only its own", async () => {
  const gpu = await initWithTimestampQuery();
  const shadows = timer(gpu);
  const main = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const shadowResults: Array<Readonly<Record<string, number>>> = [];
  const mainResults: Array<Readonly<Record<string, number>>> = [];
  shadows.onResults((spans) => { shadowResults.push(spans); });
  main.onResults((spans) => { mainResults.push(spans); });

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: shadows.span("shadows") }, () => undefined);
    currentFrame.pass({ target: colorTarget, timer: main.span("duplicate") }, () => undefined);
    currentFrame.pass({ target: colorTarget, timer: main.span("duplicate") }, () => undefined);
  })).toThrowError(/duplicate span|VGPU-TIMER-INVALID/);
  await gpu.settled();

  // The failing attachment mutated its own bookkeeping before throwing and, through the nominal
  // attach protocol, cannot report whose it was: the frame drops every owner rather than report a
  // half-encoded frame. `shadows` ran fine and is still dropped — conservative on purpose.
  expect(mainResults).toEqual([]);
  expect(shadowResults).toEqual([]);

  // The next frame is unaffected: only that frame's bookkeeping was discarded.
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: shadows.span("shadows") }, () => undefined));
  await gpu.settled();
  expect(shadowResults).toEqual([{ shadows: 1 }]);

  shadows.dispose();
  main.dispose();
  gpu.dispose();
});

test("a throwing pass callback leaves no phantom visibility result", async () => {
  const gpu = await init();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const proxy = draw(gpu, { shader: SOLID, label: "proxy" });
  // Slot 0 reads back the mock's fake value 0 — a phantom "hidden" would cull the object forever.
  const query = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, visibility: vis }, (p) => {
    p.occlusion(query, proxy);
    throw new Error("scene traversal failed");
  }))).toThrowError(/scene traversal failed/);
  await gpu.settled();

  expect(query.state).toBe("unknown");
  expect(query.hidden).toBe(false);
  expect(query.age).toBe(Infinity);
  expect(ops.encodeOps).toEqual([["finish"]]);
  vis.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a failed pass drops the whole frame's telemetry, including earlier passes of that frame", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: scene, timer: gpuTimer.span("shadows") }, () => undefined);
    currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
      p.occlusion(query, () => undefined);
      throw new Error("boom");
    });
  })).toThrowError(/boom/);
  await gpu.settled();

  // "shadows" ran, but the frame's span bookkeeping still holds the failed "main" pair, so the
  // whole frame is dropped rather than reported with a phantom entry.
  expect(results).toEqual([]);
  expect(query.state).toBe("unknown");
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
});

test("re-attaching the same telemetry after a failed pass stays dropped for that frame", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  const currentFrame = frame(gpu);
  expect(() => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(query, () => undefined);
    throw new Error("boom");
  })).toThrowError(/boom/);
  // Recovering inside the same frame cannot resurrect the frame's telemetry: the failed pass's
  // span pair and occlusion slot are still in the instances' per-frame bookkeeping.
  currentFrame.pass({ target: scene, timer: gpuTimer.span("retry"), visibility: vis }, (p) => p.occlusion(vis.query("tower"), () => undefined));
  currentFrame.submit();
  await gpu.settled();

  expect(results).toEqual([]);
  expect(query.state).toBe("unknown");
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
});

test("telemetry keeps flowing on the frame after a failed pass", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(query, () => undefined);
    throw new Error("boom");
  }))).toThrowError(/boom/);
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

test("a frame whose finish fails reports nothing and leaves telemetry usable next frame", async () => {
  const gpu = await initWithTimestampQuery();
  const failingFinish = spyFrameEncoders(gpu.device.gpu, { failFinish: true });
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });
  const query = vis.query("statue");

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(query, () => undefined);
  }))).toThrowError(/finish failed/);
  await gpu.settled();

  // The resolve was encoded but the command buffer never reached the queue: no readback may run.
  // One timer span resolves its begin/end pair (2 queries, 16 bytes); the single occlusion slot resolves 1 query.
  expect(failingFinish.encodeOps).toEqual([["resolveQuerySet", 0, 2], ["copyBufferToBuffer", 16], ["resolveQuerySet", 0, 1], ["copyBufferToBuffer", 8], ["finish"]]);
  expect(results).toEqual([]);
  expect(query.state).toBe("unknown");

  vi.restoreAllMocks();
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(query, () => undefined);
  }));
  await gpu.settled();

  expect(results).toEqual([{ main: 1 }]);
  expect(query.state).toBe("hidden");
  gpuTimer.dispose();
  vis.dispose();
  gpu.dispose();
});

test("a throwing pass callback still releases the frame's query set retain", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => {
    // dispose() lands while the pass descriptor still references the query set, so destruction is
    // deferred to the retain's release — which only happens if the dropped pass releases it.
    gpuTimer.dispose();
    throw new Error("draw setup failed");
  }))).toThrowError(/draw setup failed/);

  // frame(gpu) submits in a finally: dropping the telemetry must not drop the retain with it.
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a frame whose finish fails releases every telemetry retain it took", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  spyFrameEncoders(gpu.device.gpu, { failFinish: true });
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (p) => {
    p.occlusion(vis.query("statue"), () => undefined);
  }))).toThrowError(/finish failed/);

  // The frame never reached the queue, but both instances took a retain when they were attached:
  // without the release, these dispose()s would leave both query sets alive forever.
  expect(destroyed).toEqual([]);
  gpuTimer.dispose();
  vis.dispose();
  expect([...destroyed].sort()).toEqual([0, 1]);
  gpu.dispose();
  vi.restoreAllMocks();
});

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

interface FrameEncoderOps {
  readonly passDescriptors: GPURenderPassDescriptor[];
  readonly encodeOps: EncodeOp[];
}

/** Captures render pass descriptors plus resolve/copy/finish ordering on vgpu.frame encoders. */
function spyFrameEncoders(device: GPUDevice, opts: { failFinish?: boolean } = {}): FrameEncoderOps {
  const passDescriptors: GPURenderPassDescriptor[] = [];
  const encodeOps: EncodeOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    if (descriptor?.label !== "vgpu.frame") return encoder;
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        passDescriptors.push(renderPassDescriptor);
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
        if (opts.failFinish) throw new Error("finish failed");
        return encoder.finish(finishDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return { passDescriptors, encodeOps };
}

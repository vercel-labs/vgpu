import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter, init, frame, target, visibility } from "../src/mock.ts";
import { timer } from "../src/timer.ts";

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

test("timer(gpu) without the timestamp-query feature throws with the init guidance", async () => {
  const gpu = await init();
  expect(gpu.device.features.has("timestamp-query")).toBe(false);
  let error: unknown;
  try { timer(gpu); }
  catch (thrown) { error = thrown; }
  expect(error).toMatchObject({
    code: "VGPU-TIMER-INVALID",
    message: expect.stringContaining(`init({ requiredFeatures: ["timestamp-query"] })`),
  });
  gpu.dispose();
});

test("a span reaches the pass descriptor's timestampWrites with a valid index pair", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined));

  const writes = ops.passDescriptors[0]?.timestampWrites;
  expect(writes).toBeDefined();
  // Mirrors WebGPU "Validate timestampWrites": querySet type "timestamp", both provided
  // indices distinct and < querySet.count.
  expect(writes?.querySet.type).toBe("timestamp");
  expect(writes?.beginningOfPassWriteIndex).toBe(0);
  expect(writes?.endOfPassWriteIndex).toBe(1);
  expect(writes!.endOfPassWriteIndex!).toBeLessThan(writes!.querySet.count);
  gpuTimer1.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("untimed passes keep timestampWrites-free descriptors", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, () => undefined));

  expect(ops.passDescriptors[0]).toBeDefined();
  expect("timestampWrites" in ops.passDescriptors[0]!).toBe(false);
  expect(ops.encodeOps).toEqual([["finish"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("two spans get contiguous index pairs and one resolve of the used range before finish", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const gpuTimer1 = timer(gpu);
  const shadowMap = target(gpu, { size: [4, 4] });
  const scene = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: shadowMap, timer: gpuTimer1.span("shadows") }, () => undefined);
    currentFrame.pass({ target: scene, timer: gpuTimer1.span("main") }, () => undefined);
  });

  const first = ops.passDescriptors[0]?.timestampWrites;
  const second = ops.passDescriptors[1]?.timestampWrites;
  expect([first?.beginningOfPassWriteIndex, first?.endOfPassWriteIndex]).toEqual([0, 1]);
  expect([second?.beginningOfPassWriteIndex, second?.endOfPassWriteIndex]).toEqual([2, 3]);
  expect(second?.querySet).toBe(first?.querySet);
  // One resolveQuerySet of the contiguous used range [0, 4) plus one staging copy, appended
  // to the same frame encoder before finish — no extra encoder or submission.
  expect(ops.encodeOps).toEqual([
    ["resolveQuerySet", 0, 4],
    ["copyBufferToBuffer", 4 * 8],
    ["finish"],
  ]);
  gpuTimer1.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("onResults fires with decoded millisecond values from the mock's fake timestamps", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  const shadowMap = target(gpu, { size: [4, 4] });
  const scene = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  const unsubscribe = gpuTimer1.onResults((spans) => { results.push(spans); });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: shadowMap, timer: gpuTimer1.span("shadows") }, () => undefined);
    currentFrame.pass({ target: scene, timer: gpuTimer1.span("main") }, () => undefined);
  });
  await gpu.settled();

  // Mock fake timestamp for query i is i*i * 1e6 ns: pair (0, 1) -> 1 ms, pair (2, 3) -> 5 ms.
  expect(results).toEqual([{ shadows: 1, main: 5 }]);
  expect(Object.isFrozen(results[0])).toBe(true);

  unsubscribe();
  frame(gpu, (currentFrame) => currentFrame.pass({ target: scene, timer: gpuTimer1.span("main") }, () => undefined));
  await gpu.settled();
  expect(results).toHaveLength(1);
  gpuTimer1.dispose();
  gpu.dispose();
});

test("results keep flowing frame after frame", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer1.onResults((spans) => { results.push(spans); });

  for (let i = 0; i < 4; i++) {
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined));
    await gpu.settled();
  }

  expect(results).toEqual([{ main: 1 }, { main: 1 }, { main: 1 }, { main: 1 }]);
  gpuTimer1.dispose();
  gpu.dispose();
});

test("a duplicate span name within one frame throws at pass time", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined);
    currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined);
  })).toThrowError(/VGPU-TIMER-INVALID|duplicate span 'main'/);

  // The same name is fine again on the next frame.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined))).not.toThrow();
  gpuTimer1.dispose();
  gpu.dispose();
});

test("a span from another gpu's timer is rejected with a clear error", async () => {
  const gpuA = await initWithTimestampQuery();
  const gpuB = await initWithTimestampQuery();
  const timerA = timer(gpuA);
  const colorTarget = target(gpuB, { size: [4, 4] });

  expect(() => frame(gpuB, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: timerA.span("main") }, () => undefined)))
    .toThrowError(/VGPU-TIMER-INVALID|different gpu/);

  timerA.dispose();
  gpuA.dispose();
  gpuB.dispose();
});

test("non-TimerSpan timer options fail at pass open", async () => {
  const gpu = await initWithTimestampQuery();
  const colorTarget = target(gpu, { size: [4, 4] });
  for (const value of ["shadows", 1, {}, { name: "shadows" }, null]) {
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: value as never }, () => undefined)))
      .toThrowError(/VGPU-TIMER-INVALID|expected a TimerSpan/);
  }
  gpu.dispose();
});

test("dispose() destroys the query set and later use throws", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const span = gpuTimer1.span("main");
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: span }, () => undefined));
  await gpu.settled();

  gpuTimer1.dispose();
  expect(destroyed).toEqual([0]);
  expect(() => gpuTimer1.span("main")).toThrowError(/VGPU-TIMER-INVALID|disposed/);
  expect(() => gpuTimer1.onResults(() => undefined)).toThrowError(/VGPU-TIMER-INVALID|disposed/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: span }, () => undefined))).toThrowError(/VGPU-TIMER-INVALID|disposed/);
  expect(() => gpuTimer1.dispose()).not.toThrow();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("capacity grows at the frame boundary; overflow spans are dropped for the current frame only", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer1.onResults((spans) => { results.push(spans); });
  const spanCount = 33; // one past the initial 32-span (64-query) capacity

  const encodeFrame = () => frame(gpu, (currentFrame) => {
    for (let i = 0; i < spanCount; i++) currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span(`s${i}`) }, () => undefined);
  });

  encodeFrame();
  await gpu.settled();
  const instrumentation = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(instrumentation.createQuerySetDescriptors.map((desc) => desc.count)).toEqual([64]);
  // Span 33 is dropped this frame — the query set cannot grow mid-frame, earlier passes already reference it.
  expect(ops.passDescriptors[spanCount - 1]?.timestampWrites).toBeUndefined();
  expect(Object.keys(results[0]!)).toHaveLength(spanCount - 1);

  encodeFrame();
  await gpu.settled();
  // Growth happened at the frame boundary: a new query set doubled past the demand covers all spans.
  expect(instrumentation.createQuerySetDescriptors.map((desc) => desc.count)).toEqual([64, 128]);
  const last = ops.passDescriptors.at(-1)?.timestampWrites;
  expect([last?.beginningOfPassWriteIndex, last?.endOfPassWriteIndex]).toEqual([64, 65]);
  expect(Object.keys(results[1]!)).toHaveLength(spanCount);
  expect(results[1]![`s${spanCount - 1}`]).toBe(4 * (spanCount - 1) + 1);
  gpuTimer1.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("exceeding 2048 spans in one frame throws VGPU-TIMER-CAPACITY", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => {
    // WebGPU createQuerySet requires count <= 4096, so a timer caps at 2048 begin/end pairs per frame.
    for (let i = 0; i <= 2048; i++) currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span(`s${i}`) }, () => undefined);
  })).toThrowError(/VGPU-TIMER-CAPACITY|exceeds 2048 timed spans/);

  gpuTimer1.dispose();
  gpu.dispose();
});

test("invalid span names fail at span()", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  for (const value of ["", 1, null, undefined, {}]) {
    expect(() => gpuTimer1.span(value as never)).toThrowError(/VGPU-TIMER-INVALID|non-empty string/);
  }
  gpuTimer1.dispose();
  gpu.dispose();
});

test("span() memoizes per name and usage shape matches the docs example", async () => {
  const gpu = await initWithTimestampQuery();
  const gpuTimer1 = timer(gpu);
  expect(gpuTimer1.span("shadows")).toBe(gpuTimer1.span("shadows"));
  expect(gpuTimer1.span("shadows").name).toBe("shadows");
  gpuTimer1.dispose();
  gpu.dispose();
});

test("dispose() mid-frame keeps the query set alive until the frame is submitted", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined);
    // The pass descriptor already references the query set: destroying it here would invalidate the
    // in-flight frame, so destruction is deferred to the frame boundary.
    gpuTimer1.dispose();
    expect(destroyed).toEqual([]);
  });

  // Submit happened: the query set is released now.
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("dispose() inside a frame whose callback throws still releases the query set with that frame's cancel", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  expect(() => frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined);
    gpuTimer1.dispose();
    throw new Error("frame callback blew up");
  })).toThrowError(/frame callback blew up/);

  // frame(gpu, cb) cancels on throw, so the deferred destroy happens as soon as the frame ends.
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  expect(destroyed).toEqual([0]);
  vi.restoreAllMocks();
});

test("a frame left open keeps its retain no matter how many frames run after it", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  // Manual frame that is still open: it references the query set from a pass descriptor, so its
  // retain is only released when it reports back (submit, failure or abandon) — never by age.
  const open = frame(gpu);
  open.pass({ target: colorTarget, timer: gpuTimer1.span("open") }, () => undefined);
  for (let index = 0; index < 12; index++) {
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span(`main${index}`) }, () => undefined));
  }
  await gpu.settled();

  gpuTimer1.dispose();
  // Destruction stays deferred: guessing "abandoned" from age would free a set this frame can still use.
  expect(destroyed).toEqual([]);
  // And the long-open frame can still be submitted safely, long after dispose().
  expect(() => open.submit()).not.toThrow();
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a stale frame submitted after many later frames reports nothing and destroys the set only on close", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer1.onResults((spans) => { results.push(spans); });

  const stale = frame(gpu);
  stale.pass({ target: colorTarget, timer: gpuTimer1.span("stale") }, () => undefined);
  for (let index = 0; index < 10; index++) {
    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined));
  }
  await gpu.settled();
  // Only the frames whose staging slot was free report back (the ring drops rather than blocks), but
  // every result belongs to a live frame: nothing is attributed to the stale one.
  const beforeStale = results.length;
  expect(beforeStale).toBeGreaterThan(0);
  expect(results.every((spans) => Object.keys(spans).join() === "main")).toBe(true);

  // The stale frame lost the timer's identity long ago: it encodes no resolve, so no phantom "stale"
  // result appears, and no query set was destroyed early while its encoder still referenced one.
  stale.submit();
  await gpu.settled();
  expect(results).toHaveLength(beforeStale);
  expect(destroyed).toEqual([]);

  // Its retain is released on submit, so a dispose() afterwards destroys immediately.
  gpuTimer1.dispose();
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("gpu.dispose() cancels an open frame and releases its retained query set", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  const leaked = frame(gpu);
  leaked.pass({ target: colorTarget, timer: gpuTimer1.span("leaked") }, () => undefined);
  await gpu.settled();

  // Manual frames belong to the scheduler phase, so gpu.dispose() cancels them before resource
  // teardown. That releases the frame's retain and lets the query set be destroyed safely.
  expect(() => gpu.dispose()).not.toThrow();
  expect(destroyed).toEqual([0]);
  // The disposed timer is unusable, and nothing crashes on the way out.
  expect(() => gpuTimer1.span("after")).toThrowError(/disposed/i);
  expect(() => gpuTimer1.dispose()).not.toThrow();
  expect(destroyed).toEqual([0]);
  vi.restoreAllMocks();
});

test("two frames open at once each hold their own retain: the query set outlives dispose() until the last one closes", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);          // query set 0
  const vis = visibility(gpu);       // query set 1
  const statue = vis.query("statue");
  const colorTarget = target(gpu, { size: [4, 4], depth: true });
  const spans: Array<Readonly<Record<string, number>>> = [];
  gpuTimer1.onResults((results) => { spans.push(results); });

  // Two manual frames open simultaneously, sharing the same timer and the same visibility instance.
  const first = frame(gpu);
  first.pass({ target: colorTarget, timer: gpuTimer1.span("first"), visibility: vis }, (pass) => pass.occlusion(statue, () => undefined));
  const second = frame(gpu);
  second.pass({ target: colorTarget, timer: gpuTimer1.span("second"), visibility: vis }, (pass) => pass.occlusion(statue, () => undefined));

  gpuTimer1.dispose();
  vis.dispose();
  // Both frames still point at both query sets from their pass descriptors.
  expect(destroyed).toEqual([]);
  second.submit();
  // The newer frame is submitted, but the older one is still open and references the same sets.
  expect(destroyed).toEqual([]);
  first.submit();
  // Only now is nothing referencing them: timer set first (created first), then the visibility set.
  expect(destroyed).toEqual([0, 1]);

  await gpu.settled();
  // No phantom results: both frames were disposed mid-flight, and the older frame lost its identity
  // to the newer one, so nothing is read back and no handle silently latches "hidden".
  expect(spans).toEqual([]);
  expect(statue.state).toBe("unknown");
  expect(statue.hidden).toBe(false);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("the abandon path releases the retain of its own frame, not of the other open frame", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  // The older frame's pass fails, so its telemetry is rolled back: it will end through the abandon
  // path (frameAbandoned) instead of a real readback.
  const first = frame(gpu);
  expect(() => first.pass({ target: colorTarget, timer: gpuTimer1.span("first") }, () => { throw new Error("pass body blew up"); })).toThrowError(/pass body blew up/);
  const second = frame(gpu);
  second.pass({ target: colorTarget, timer: gpuTimer1.span("second") }, () => undefined);
  gpuTimer1.dispose();
  expect(destroyed).toEqual([]);

  // Abandoning the older frame releases only its own retain: the second frame is still encoding
  // against the same query set.
  first.submit();
  expect(destroyed).toEqual([]);
  second.submit();
  expect(destroyed).toEqual([0]);
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a readback that fails is reported on gpu.onError as VGPU-QUERY-READBACK", async () => {
  const gpu = await initWithTimestampQuery();
  failStagingMaps(gpu.device.gpu);
  const errors: Array<{ code: string; message: string }> = [];
  gpu.onError((error) => { errors.push(error); });
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: unknown[] = [];
  gpuTimer1.onResults((spans) => { results.push(spans); });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined));
  await gpu.settled();

  expect(results).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "VGPU-QUERY-READBACK", message: expect.stringContaining("vgpu.timer") });
  gpuTimer1.dispose();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("gpu.dispose() releases timers created by that gpu", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer1 = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer1.span("main") }, () => undefined));
  await gpu.settled();

  gpu.dispose();
  expect(destroyed).toEqual([0]);
  // The timer is disposed too, so its use throws and re-disposing is a no-op.
  expect(() => gpuTimer1.span("main")).toThrowError(/VGPU-TIMER-INVALID|disposed/);
  expect(() => gpuTimer1.dispose()).not.toThrow();
  vi.restoreAllMocks();
});

/** Makes every query-ring staging mapAsync reject, as a lost device would. */
function failStagingMaps(device: GPUDevice): void {
  const originalCreateBuffer = device.createBuffer.bind(device);
  vi.spyOn(device, "createBuffer").mockImplementation((descriptor: GPUBufferDescriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    if (descriptor.label?.includes("staging")) {
      (buffer as { mapAsync: GPUBuffer["mapAsync"] }).mapAsync = () => Promise.reject(new Error("device lost"));
    }
    return buffer;
  });
}

type EncodeOp = readonly [name: string, ...args: unknown[]];

interface FrameEncoderOps {
  readonly passDescriptors: GPURenderPassDescriptor[];
  readonly encodeOps: EncodeOp[];
}

/** Captures render pass descriptors plus resolve/copy/finish ordering on vgpu.frame encoders. */
function spyFrameEncoders(device: GPUDevice): FrameEncoderOps {
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
        return encoder.finish(finishDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return { passDescriptors, encodeOps };
}

/** Records the creation index of each destroyed query set. */
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

// --- gpu-first factory (T202-03) --------------------------------------------------------------

test("timer(gpu) produces the same instrumented timer as the facade and reports through the gpu error channel", async () => {
  const gpu = await initWithTimestampQuery();
  const ops = spyFrameEncoders(gpu.device.gpu);
  const gpuTimer = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const results: Array<Readonly<Record<string, number>>> = [];
  gpuTimer.onResults((spans) => { results.push(spans); });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: gpuTimer.span("main") }, () => undefined));
  // The readback is tracked on the kernel, so it is covered by gpu.settled() without the facade.
  await gpu.settled();

  expect(ops.passDescriptors[0]?.timestampWrites).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
  expect(results).toEqual([{ main: 1 }]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a timer(gpu) left open goes down with the gpu, and disposing it first drops its registration", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const owned = timer(gpu);
  const released = timer(gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, timer: owned.span("main") }, () => undefined));
  await gpu.settled();

  released.dispose();
  expect(destroyed).toEqual([1]);

  // No timer.dispose() for `owned`: the kernel owns it in the resource phase.
  gpu.dispose();
  expect(destroyed.sort()).toEqual([0, 1]);
  // Idempotent: the disposer ran once, and the timer's own dispose() after teardown is still safe.
  expect(() => owned.dispose()).not.toThrow();
  vi.restoreAllMocks();
});

test("timer(gpu) after gpu.dispose() throws VGPU-GPU-DISPOSED instead of building on a dead device", async () => {
  const gpu = await initWithTimestampQuery();
  gpu.dispose();
  expect(thrownBy(() => timer(gpu))).toMatchObject({
    code: "VGPU-GPU-DISPOSED",
    where: "timer",
    message: expect.stringContaining("after gpu.dispose()"),
  });
});

test("timer(gpu) rejects an object this library did not create", () => {
  expect(thrownBy(() => timer({ disposed: false } as never))).toMatchObject({ code: "VGPU-GPU-FOREIGN" });
});

/** Returns what `run` threw, so an assertion can inspect the VGPUError's code instead of its message. */
function thrownBy(run: () => unknown): unknown {
  try { run(); }
  catch (error) { return error; }
  throw new Error("expected the call to throw");
}

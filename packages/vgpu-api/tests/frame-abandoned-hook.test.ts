import { expect, test, vi } from "vitest";
import { createMockAdapter, init } from "../src/mock.ts";
import { InternalTimer, type InternalTimerSpan } from "../src/timer.ts";
import { InternalVisibility } from "../src/visibility.ts";

/**
 * Direct unit tests of the telemetry abandon hook that Frame calls for frames which never reach the
 * queue (a failed pass, a failed finish/submit, cancel()). Behavior through the public API is
 * covered by pass-telemetry-rollback.test.ts and frame-cancel.test.ts; this pins the contract of the
 * hook itself: drop the pending encoded state (no readback) and release *that* frame's ring retain.
 */

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

test("timer.frameAbandoned releases the frame's retain so a deferred dispose can destroy the query set", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const timer = new InternalTimer(gpu.device, {});
  const frame = { label: "frame" };

  timer.attachSpan(timerSpan(timer, "main"), frame, gpu.device);
  timer.dispose();
  // The frame's pass descriptor still references the query set, so destruction is deferred.
  expect(destroyed).toEqual([]);

  timer.frameAbandoned(frame);
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("timer.frameAbandoned drops the encoded resolve, so no readback can decode stale bytes", async () => {
  const gpu = await initWithTimestampQuery();
  const readbacks: Promise<unknown>[] = [];
  const results: Array<Readonly<Record<string, number>>> = [];
  const timer = new InternalTimer(gpu.device, { trackSettled: (promise) => { readbacks.push(promise); } });
  timer.onResults((spans) => { results.push(spans); });
  const frame = { label: "frame" };

  timer.attachSpan(timerSpan(timer, "main"), frame, gpu.device);
  const encoder = gpu.device.gpu.createCommandEncoder();
  timer.finalizeFrame(frame, encoder); // the resolve is encoded, but the encoder is never submitted
  timer.frameAbandoned(frame);
  // Even a late frameSubmitted for the abandoned frame cannot resurrect the dropped state.
  timer.frameSubmitted(frame);
  await Promise.allSettled(readbacks);

  expect(readbacks).toEqual([]);
  expect(results).toEqual([]);
  timer.dispose();
  gpu.dispose();
});

test("timer.frameAbandoned only drops the abandoned frame: the newer frame still reports", async () => {
  const gpu = await initWithTimestampQuery();
  const readbacks: Promise<unknown>[] = [];
  const results: Array<Readonly<Record<string, number>>> = [];
  const timer = new InternalTimer(gpu.device, { trackSettled: (promise) => { readbacks.push(promise); } });
  timer.onResults((spans) => { results.push(spans); });
  const stale = { label: "stale" };
  const current = { label: "current" };

  timer.attachSpan(timerSpan(timer, "main"), stale, gpu.device);
  timer.attachSpan(timerSpan(timer, "main"), current, gpu.device); // opening a frame retargets the bookkeeping
  timer.frameAbandoned(stale);

  const encoder = gpu.device.gpu.createCommandEncoder();
  timer.finalizeFrame(current, encoder);
  timer.frameSubmitted(current);
  await Promise.allSettled(readbacks);

  // Mock fake timestamp for query i is i*i * 1e6 ns: the pair (0, 1) decodes to 1 ms.
  expect(results).toEqual([{ main: 1 }]);
  timer.dispose();
  gpu.dispose();
});

test("visibility.frameAbandoned releases the frame's retain so a deferred dispose can destroy the query set", async () => {
  const gpu = await init();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const vis = new InternalVisibility(gpu.device, {}, () => 0, {});
  const frame = { label: "frame" };

  vis.attachFrame(frame, gpu.device);
  vis.dispose();
  expect(destroyed).toEqual([]);

  vis.frameAbandoned(frame);
  expect(destroyed).toEqual([0]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("visibility.frameAbandoned drops the encoded resolve, so no handle latches a phantom result", async () => {
  const gpu = await init();
  const readbacks: Promise<unknown>[] = [];
  const vis = new InternalVisibility(gpu.device, {}, () => 0, { trackSettled: (promise) => { readbacks.push(promise); } });
  const query = vis.query("statue"); // slot 0 reads back the mock's fake value 0 -> a phantom "hidden"
  const frame = { label: "frame" };

  vis.attachFrame(frame, gpu.device);
  vis.beginQuery(query, frame);
  const encoder = gpu.device.gpu.createCommandEncoder();
  vis.finalizeFrame(frame, encoder);
  vis.frameAbandoned(frame);
  vis.frameSubmitted(frame);
  await Promise.allSettled(readbacks);

  expect(readbacks).toEqual([]);
  expect(query.state).toBe("unknown");
  expect(query.hidden).toBe(false);
  vis.dispose();
  gpu.dispose();
});

/** Timer.span() hands back the public handle; these tests drive the frame hooks on the span itself. */
function timerSpan(timer: InternalTimer, name: string): InternalTimerSpan {
  return timer.span(name) as InternalTimerSpan;
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

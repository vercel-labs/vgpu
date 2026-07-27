import { describe, expect, it, vi } from 'vitest';
import { coordinateGrid, evaluateCppnImage, GRID, PIXELS, RGBA_BYTES, TIME_SCALE } from './evaluate';
import { createFpsMeter, createFramePump } from './frame-pump';
import { MODEL_SHA256 } from './model-weights.generated';
import { THUMB_TIME } from './renderer';

describe('coordinate grid', () => {
  const coords = coordinateGrid();

  it('is a flat pixel-centred [-1, 1) grid in the model input layout', () => {
    expect(coords.length).toBe(PIXELS * 2);
    // p = y * GRID + x, coords[2p] = x, coords[2p + 1] = y.
    expect(coords[0]).toBeCloseTo(-1 + 1 / GRID, 6);
    expect(coords[1]).toBeCloseTo(-1 + 1 / GRID, 6);
    const last = (PIXELS - 1) * 2;
    expect(coords[last]).toBeCloseTo(1 - 1 / GRID, 6);
    expect(coords[last + 1]).toBeCloseTo(1 - 1 / GRID, 6);
  });

  it('varies x fastest', () => {
    const p = 3 * GRID + 7;
    expect(coords[2 * p]).toBeCloseTo(((7 + 0.5) / GRID) * 2 - 1, 6);
    expect(coords[2 * p + 1]).toBeCloseTo(((3 + 0.5) / GRID) * 2 - 1, 6);
  });
});

describe('CPU evaluator', () => {
  const image = evaluateCppnImage(THUMB_TIME * TIME_SCALE);

  it('emits exactly one NHWC RGBA float32 image', () => {
    expect(image.length).toBe(PIXELS * 4);
    expect(image.byteLength).toBe(RGBA_BYTES);
    expect(RGBA_BYTES).toBe(1_048_576);
  });

  it('keeps colours in the sigmoid range with opaque alpha', () => {
    for (let p = 0; p < PIXELS; p += 997) {
      const base = p * 4;
      for (let c = 0; c < 3; c++) {
        const value = image[base + c]!;
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(1);
      }
      expect(image[base + 3]).toBe(1);
    }
  });

  // Golden values produced by onnxruntime 1.28 (CPU EP) running the committed
  // model.onnx with the same coordinate grid and time. They guard the evaluator
  // against drift from the ONNX graph, within float32 tolerance.
  it('matches ONNX Runtime output on sampled pixels', () => {
    const golden: ReadonlyArray<readonly [number, number, readonly [number, number, number]]> = [
      [0, 0, [0.483935, 0.394291, 0.399696]],
      [1, 0, [0.491906, 0.409075, 0.398981]],
      [128, 128, [0.781223, 0.893988, 0.697067]],
      [255, 255, [0.312882, 0.313097, 0.403417]],
      [64, 192, [0.148464, 0.61899, 0.747342]],
    ];
    for (const [x, y, expected] of golden) {
      const base = (y * GRID + x) * 4;
      for (let c = 0; c < 3; c++) {
        expect(image[base + c]!).toBeCloseTo(expected[c]!, 4);
      }
    }
  });

  it('animates with time', () => {
    const later = evaluateCppnImage((THUMB_TIME + 1.5) * TIME_SCALE);
    let changed = 0;
    for (let i = 0; i < image.length; i += 4) {
      if (Math.abs(image[i]! - later[i]!) > 0.01) changed++;
    }
    expect(changed).toBeGreaterThan(PIXELS * 0.25);
  });

  it('pins the model hash the weights were generated from', () => {
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('single-flight frame pump', () => {
  function createHost() {
    const queue: Array<(timestampMs: number) => void> = [];
    let nextHandle = 1;
    const cancelled: number[] = [];
    return {
      queue,
      cancelled,
      requestFrame(callback: (timestampMs: number) => void) {
        queue.push(callback);
        return nextHandle++;
      },
      cancelFrame(handle: number) {
        cancelled.push(handle);
      },
      /** Runs the frame callbacks currently queued. */
      flush(timestampMs = 0) {
        const pending = queue.splice(0, queue.length);
        for (const callback of pending) callback(timestampMs);
      },
    };
  }

  it('never runs two frames concurrently', async () => {
    const host = createHost();
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveRun: (() => void) | undefined;
    const pump = createFramePump({
      requestFrame: host.requestFrame,
      cancelFrame: host.cancelFrame,
      onError: () => {},
      run: () =>
        new Promise<void>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolveRun = () => {
            inFlight--;
            resolve();
          };
        }),
    });

    pump.start();
    host.flush(0);
    // A second rAF tick while the first frame is still running must not start one.
    host.flush(16);
    expect(maxInFlight).toBe(1);
    expect(host.queue.length).toBe(0);

    resolveRun?.();
    await pump.active;
    await Promise.resolve();
    expect(host.queue.length).toBe(1);
    expect(maxInFlight).toBe(1);
    pump.stop();
  });

  it('stops scheduling after stop() and exposes the in-flight frame', async () => {
    const host = createHost();
    let resolveRun: (() => void) | undefined;
    let runs = 0;
    const pump = createFramePump({
      requestFrame: host.requestFrame,
      cancelFrame: host.cancelFrame,
      onError: () => {},
      run: () =>
        new Promise<void>((resolve) => {
          runs++;
          resolveRun = resolve;
        }),
    });
    pump.start();
    host.flush(0);
    const active = pump.stop();
    expect(active).toBeInstanceOf(Promise);
    resolveRun?.();
    await active;
    host.flush(16);
    expect(runs).toBe(1);
  });

  it('reports the first failure once and stops', async () => {
    const host = createHost();
    const onError = vi.fn();
    const pump = createFramePump({
      requestFrame: host.requestFrame,
      cancelFrame: host.cancelFrame,
      onError,
      run: () => Promise.reject(new Error('inference failed')),
    });
    pump.start();
    host.flush(0);
    await pump.active?.catch(() => undefined);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    host.flush(16);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('fps meter', () => {
  it('reports only once per window', () => {
    const meter = createFpsMeter(500);
    expect(meter.sample(0)).toBeUndefined();
    expect(meter.sample(100)).toBeUndefined();
    const fps = meter.sample(500);
    expect(fps).toBeDefined();
    expect(fps!).toBeCloseTo(6, 5);
    expect(meter.sample(600)).toBeUndefined();
  });
});

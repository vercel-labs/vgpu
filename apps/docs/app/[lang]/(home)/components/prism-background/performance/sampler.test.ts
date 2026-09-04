import type { Gpu, Timer, TimerSpan } from "vgpu";
import { afterEach, expect, test, vi } from "vitest";

import type { PrismRuntime } from "../runtime/types";
import { createPrismPerformanceSampler } from "./sampler";

afterEach(() => vi.useRealTimers());

test("samples warmup + deterministic frames and reports CPU, mesh, passes, and GPU", async () => {
  vi.useFakeTimers();
  let clock = 0;
  let results: ((spans: Readonly<Record<string, number>>) => void) | undefined;
  const disposeTimer = vi.fn();
  const fakeTimer: Timer = {
    span: (name): TimerSpan => ({ name }),
    onResults(callback) {
      results = callback;
      return vi.fn();
    },
    dispose: disposeTimer,
  };
  const runtime = {
    lampArc: 0.5,
    lampTarget: 0.5,
    orbit: [0, 0],
  } as unknown as PrismRuntime;
  const gpu = {
    device: {
      features: new Set(["timestamp-query", "rg11b10ufloat-renderable"]),
    },
  } as unknown as Gpu;
  const restoreState = vi.fn();
  const invalidate = vi.fn();
  const sampler = createPrismPerformanceSampler({
    gpu,
    runtime,
    now: () => clock,
    timerFactory: () => fakeTimer,
    drain: async () => {},
    restoreState,
  });
  const reportPromise = sampler.start({
    mode: "light",
    resolution: [800, 450],
    frames: 4,
    warmupFrames: 2,
    invalidate,
  });

  for (let index = 0; index < 6; index += 1) {
    clock = index * 16;
    const frame = sampler.beginFrame("light")!;
    runtime.measurementSink?.recordLightMesh({
      buildMs: 1,
      uploadMs: 0.25,
      bytes: 100,
    });
    const span = frame.profile.pass("light.scene");
    if (span) results?.({ [span.name]: 0.75 });
    clock += 2;
    sampler.endFrame(frame);
  }
  await vi.runAllTimersAsync();
  const report = await reportPromise;

  expect(report.mode).toBe("light");
  expect(report.scenario).toBe("pointer");
  expect(report.resolution).toEqual([800, 450]);
  expect(report.recordedFrames).toBe(4);
  expect(report.timing.frameInterval).toMatchObject({
    samples: 4,
    p50: 16,
    p95: 16,
  });
  expect(report.timing.cpuEncode).toMatchObject({ samples: 4, p50: 2 });
  expect(report.lightMesh).toMatchObject({
    rebuilds: 4,
    totalUploadedBytes: 400,
    build: { samples: 4, p50: 1 },
    upload: { samples: 4, p50: 0.25 },
    total: { samples: 4, p50: 1.25 },
  });
  expect(report.passes["light.scene"]).toMatchObject({
    encodedFrames: 4,
    gpu: { samples: 4, p50: 0.75 },
  });
  expect(report.capabilities).toEqual({
    timestampQuery: true,
    rg11b10ufloatRenderable: true,
    visibleBloomFormat: "rg11b10ufloat",
    particleLightFormat: "rgba16float",
  });
  expect(runtime.measurementSink).toBeUndefined();
  expect(restoreState).toHaveBeenCalledWith([0.5, 0.5], [0, 0]);
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(disposeTimer).toHaveBeenCalledOnce();
});

test("samples only retained dark dust after a mandatory cache warmup", async () => {
  vi.useFakeTimers();
  let clock = 0;
  const runtime = {
    lampArc: 0.5,
    lampTarget: 0.5,
    orbit: [0, 0],
  } as unknown as PrismRuntime;
  const gpu = {
    device: { features: new Set<string>() },
  } as unknown as Gpu;
  const sampler = createPrismPerformanceSampler({
    gpu,
    runtime,
    now: () => clock,
    drain: async () => {},
    restoreState: vi.fn(),
  });
  const reportPromise = sampler.start({
    mode: "dark",
    scenario: "dark-dust",
    resolution: [800, 450],
    frames: 3,
    warmupFrames: 0,
    invalidate: vi.fn(),
  });

  for (let index = 0; index < 4; index += 1) {
    clock = index * 16;
    const frame = sampler.beginFrame("dark")!;
    expect(frame).toMatchObject({
      scenario: "dark-dust",
      updateScene: index === 0,
      dustTime: index / 30,
    });
    expect(frame.aim).toBeUndefined();
    expect(frame.orbit).toBeUndefined();
    frame.profile.pass("dark.output");
    clock += 1;
    sampler.endFrame(frame);
  }
  await vi.runAllTimersAsync();
  const report = await reportPromise;

  expect(report).toMatchObject({
    mode: "dark",
    scenario: "dark-dust",
    requested: { frames: 3, warmupFrames: 1 },
    recordedFrames: 3,
    lightMesh: { rebuilds: 0, totalUploadedBytes: 0 },
    passes: { "dark.output": { encodedFrames: 3 } },
  });
  expect(Object.keys(report.passes)).toEqual(["dark.output"]);
});

test("rejects the dark-dust scenario on the light pipeline", async () => {
  const runtime = {} as PrismRuntime;
  const gpu = {} as Gpu;
  const sampler = createPrismPerformanceSampler({ gpu, runtime });

  await expect(
    sampler.start({
      mode: "light",
      scenario: "dark-dust",
      resolution: [800, 450],
      invalidate: vi.fn(),
    })
  ).rejects.toThrow('The "dark-dust" scenario requires the dark pipeline.');
});

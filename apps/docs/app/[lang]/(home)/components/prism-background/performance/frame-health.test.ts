import { expect, test } from "vitest";

import { createPrismFrameHealthMonitor } from "./frame-health";

function runFrames({
  fps,
  frames,
  rendered,
  mobile = false,
  workload = "interactive" as const,
}: {
  fps: number;
  frames: number;
  rendered(index: number): boolean;
  mobile?: boolean;
  workload?: "interactive" | "dust";
}) {
  const monitor = createPrismFrameHealthMonitor();
  let status;
  for (let index = 0; index < frames; index += 1) {
    status = monitor.record({
      deltaMs: 1_000 / fps,
      active: true,
      rendered: rendered(index),
      mobile,
      workload,
    });
  }
  return { monitor, status: status! };
}

test.each([60, 90] as const)(
  "keeps a healthy %d Hz interactive pipeline High",
  (fps) => {
    const { status } = runFrames({
      fps,
      frames: fps * 3,
      rendered: () => true,
    });
    expect(status.estimatedRefreshFps).toBeCloseTo(fps, 0);
    expect(status.targetFps).toBeCloseTo(fps, 0);
    expect(status.downgrade).toBe(false);
  }
);

test("caps a stable 120 Hz display target at 90 FPS", () => {
  const { status } = runFrames({
    fps: 120,
    frames: 360,
    rendered: (index) => index % 4 !== 0,
  });
  expect(status.estimatedRefreshFps).toBeCloseTo(120, 0);
  expect(status.targetFps).toBe(90);
  expect(status.downgrade).toBe(false);
});

test.each([
  [true, "interactive"],
  [false, "dust"],
] as const)("uses a 30 FPS target for mobile=%s workload=%s", (mobile, workload) => {
  const { status } = runFrames({
    fps: 120,
    frames: 360,
    rendered: (index) => index % 4 === 0,
    mobile,
    workload,
  });
  expect(status.targetFps).toBe(30);
  expect(status.downgrade).toBe(false);
});

test("requests Low only after two active seconds below 80% of target", () => {
  const monitor = createPrismFrameHealthMonitor();
  for (let index = 0; index < 119; index += 1) {
    const status = monitor.record({
      deltaMs: 1_000 / 60,
      active: true,
      rendered: index % 3 === 0,
      mobile: false,
      workload: "interactive",
    });
    expect(status.downgrade).toBe(false);
  }
  const status = monitor.record({
    deltaMs: 1_000 / 60,
    active: true,
    rendered: false,
    mobile: false,
    workload: "interactive",
  });
  expect(status.downgrade).toBe(true);
  expect(status.thresholdFps).toBe(48);
  expect(status.observedFps).toBeLessThan(48);
  expect(status.activeWindowMs).toBeCloseTo(2_000, 0);
});

test("inactivity and explicit resets discard a partial unhealthy window", () => {
  const monitor = createPrismFrameHealthMonitor();
  const badFrame = {
    deltaMs: 1_000 / 60,
    active: true,
    rendered: false,
    mobile: false,
    workload: "interactive" as const,
  };
  for (let index = 0; index < 90; index += 1) monitor.record(badFrame);
  monitor.record({ ...badFrame, active: false });
  for (let index = 0; index < 90; index += 1)
    expect(monitor.record(badFrame).downgrade).toBe(false);
  monitor.reset();
  for (let index = 0; index < 119; index += 1)
    expect(monitor.record(badFrame).downgrade).toBe(false);
});

test("a long callback gap resets active health instead of judging a hidden tab", () => {
  const monitor = createPrismFrameHealthMonitor();
  const sample = {
    deltaMs: 1_000 / 60,
    active: true,
    rendered: false,
    mobile: false,
    workload: "interactive" as const,
  };
  for (let index = 0; index < 90; index += 1) monitor.record(sample);
  expect(monitor.record({ ...sample, deltaMs: 500 }).downgrade).toBe(false);
  for (let index = 0; index < 90; index += 1)
    expect(monitor.record(sample).downgrade).toBe(false);
});

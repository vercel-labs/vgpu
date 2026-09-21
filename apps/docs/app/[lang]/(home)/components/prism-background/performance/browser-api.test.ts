import { afterEach, expect, test, vi } from "vitest";

import type { PrismRenderer } from "../renderer";
import {
  installPrismPerformanceBrowserApi,
  parsePrismPerformanceUrl,
  PRISM_PERFORMANCE_BRIDGE_ID,
  PRISM_PERFORMANCE_RUN_EVENT,
} from "./browser-api";
import type { PrismPerformanceReport } from "./types";

afterEach(() => vi.unstubAllGlobals());

test("bridges isolated-world DOM events to the main-world sampler", async () => {
  const bridge = new FakeElement();
  const windowValue: Record<string, unknown> = { location: { search: "" } };
  vi.stubGlobal("window", windowValue);
  vi.stubGlobal("document", {
    createElement: vi.fn(() => bridge),
    body: { append: vi.fn() },
  });
  const report = sampleReport();
  const measurePerformance = vi.fn(async () => report);
  const renderer = {
    ready: Promise.resolve(),
    measurePerformance,
  } as unknown as PrismRenderer;

  const remove = installPrismPerformanceBrowserApi(renderer);
  await Promise.resolve();
  expect(bridge.id).toBe(PRISM_PERFORMANCE_BRIDGE_ID);
  expect(bridge.hidden).toBe(true);
  expect(bridge.dataset.state).toBe("ready");

  bridge.dataset.options = JSON.stringify({ mode: "light", frames: 120 });
  bridge.dispatchEvent(
    new Event(PRISM_PERFORMANCE_RUN_EVENT, { bubbles: true })
  );
  expect(bridge.dataset.state).toBe("running");
  await vi.waitFor(() => expect(bridge.dataset.state).toBe("complete"));
  expect(measurePerformance).toHaveBeenCalledWith({
    mode: "light",
    frames: 120,
  });
  expect(JSON.parse(bridge.textContent)).toEqual(report);

  remove();
  expect(bridge.removed).toBe(true);
  expect(windowValue.__prismPerformance).toBeUndefined();
});

test("parses URL autostart while preserving empty manual mode", () => {
  expect(parsePrismPerformanceUrl("?prism-perf")).toBeUndefined();
  expect(parsePrismPerformanceUrl("?prism-perf=other")).toBeUndefined();
  expect(
    parsePrismPerformanceUrl(
      "?prism-perf=dark&prism-perf-frames=96&prism-perf-warmup=0"
    )
  ).toEqual({ mode: "dark", frames: 96, warmupFrames: 0 });
  expect(
    parsePrismPerformanceUrl(
      "?prism-perf=light&prism-perf-frames=0&prism-perf-warmup=-2"
    )
  ).toEqual({ mode: "light" });
  expect(
    parsePrismPerformanceUrl(
      "?prism-perf=dark-dust&prism-perf-frames=120&prism-perf-warmup=16"
    )
  ).toEqual({
    mode: "dark",
    scenario: "dark-dust",
    frames: 120,
    warmupFrames: 16,
  });
});

class FakeElement extends EventTarget {
  id = "";
  hidden = false;
  dataset: Record<string, string | undefined> = {};
  textContent = "";
  removed = false;

  remove() {
    this.removed = true;
  }
}

function sampleReport(): PrismPerformanceReport {
  const empty = { samples: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  return {
    version: 1,
    capturedAt: "2026-08-26T00:00:00.000Z",
    mode: "light",
    scenario: "pointer",
    resolution: [800, 450],
    requested: { frames: 120, warmupFrames: 16 },
    recordedFrames: 120,
    capabilities: {
      timestampQuery: false,
      rg11b10ufloatRenderable: false,
      visibleBloomFormat: "rgba16float",
      particleLightFormat: "rgba16float",
    },
    timing: { frameInterval: empty, cpuEncode: empty },
    lightMesh: {
      rebuilds: 0,
      totalUploadedBytes: 0,
      bytesPerRebuild: empty,
      build: empty,
      upload: empty,
      total: empty,
    },
    passes: {},
  };
}

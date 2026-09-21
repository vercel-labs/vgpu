import { describe, expect, test, vi } from "vitest";
import type { Gpu } from "vgpu";
import { effect, frame, init, sampler, target } from "vgpu/mock";

import type { PrismPipeline } from "../../pipelines/types";
import type { PrismRuntime } from "../../runtime/types";
import type { PrismDebugSource } from "../../pipelines/types";
import { createPrismDebugPreviewHost } from "./host";
import type {
  DebuggableLightPipeline,
  DebuggableTargetPipeline,
  PrismDebugDrawSet,
} from "./types";

const SOLID = `
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}`;

describe("GPU debug preview host", () => {
  test("keeps one stable bridge and owns a fixed small surface per attachment", async () => {
    const gpu = await init();
    const pipeline = lightPipeline(gpu);
    const host = createHost(gpu, () => pipeline);
    const canvas = canvasLike();
    const bridge = host.bridge;
    const staleDetach = bridge.attachPreview({
      canvas,
      source: debugSource("scene-hdr"),
    });
    const detach = bridge.attachPreview({
      canvas,
      source: debugSource("final-output"),
    });

    expect(host.bridge).toBe(bridge);
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(144);
    expect(contextOf(canvas).configure).toHaveBeenCalledTimes(2);
    expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(1);
    staleDetach();
    expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(1);
    detach();
    detach();
    expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(2);

    host.dispose();
    gpu.dispose();
  });

  test("renders live targets near 10fps without loading entry-point draws", async () => {
    const gpu = await init();
    const createDebugDraws = vi.fn(async () => ({ sources: {} }));
    const pipeline = lightPipeline(gpu, createDebugDraws);
    const requestRender = vi.fn();
    const host = createHost(gpu, () => pipeline, requestRender);
    const canvas = canvasLike();
    host.bridge.attachPreview({ canvas, source: debugSource("scene-hdr") });

    renderHost(gpu, host, 0);
    await settle();
    renderHost(gpu, host, 0);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(createDebugDraws).not.toHaveBeenCalled();

    host.invalidate();
    const callsAfterInvalidation = requestRender.mock.calls.length;
    renderHost(gpu, host, 0.05);
    renderHost(gpu, host, 0.06);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(callsAfterInvalidation);
    renderHost(gpu, host, 0.11);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(4);
    expect(requestRender).toHaveBeenCalled();

    dispose(gpu, host);
  });

  test("renders static entry points once but refreshes their shared bindings", async () => {
    const gpu = await init();
    const raw = effect(gpu, SOLID, { label: "test.raw-caustic" });
    const bind = vi.fn();
    const createDebugDraws = vi.fn(
      async (): Promise<PrismDebugDrawSet> => ({
        sources: { "raw-caustic": raw },
        bind,
      })
    );
    const pipeline = lightPipeline(gpu, createDebugDraws);
    const host = createHost(gpu, () => pipeline);
    const canvas = canvasLike();
    host.bridge.attachPreview({ canvas, source: debugSource("raw-caustic") });

    renderHost(gpu, host, 0);
    await settle();
    renderHost(gpu, host, 0);
    await settle();
    renderHost(gpu, host, 0);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(createDebugDraws).toHaveBeenCalledTimes(1);

    host.invalidate();
    renderHost(gpu, host, 1);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledTimes(2);

    dispose(gpu, host);
  });

  test("renders dark targets through the same preview path", async () => {
    const gpu = await init();
    const dark = darkPipeline(gpu);
    const host = createHost(gpu, () => dark);
    const canvas = canvasLike();
    host.bridge.attachPreview({
      canvas,
      source: debugSource("dark-scene-hdr"),
    });

    renderHost(gpu, host, 0);
    await settle();
    renderHost(gpu, host, 0);
    expect(contextOf(canvas).getCurrentTexture).toHaveBeenCalledTimes(2);

    host.dispose();
    expect(contextOf(canvas).unconfigure).toHaveBeenCalledTimes(1);
    gpu.dispose();
  });

  test("ignores stale debug draw work after a pipeline switch", async () => {
    const gpu = await init();
    const firstResult = deferred<PrismDebugDrawSet>();
    const secondResult = deferred<PrismDebugDrawSet>();
    const first = lightPipeline(
      gpu,
      vi.fn(() => firstResult.promise)
    );
    const second = lightPipeline(
      gpu,
      vi.fn(() => secondResult.promise)
    );
    let active: PrismPipeline = first;
    const requestRender = vi.fn();
    const host = createHost(gpu, () => active, requestRender);
    host.bridge.attachPreview({
      canvas: canvasLike(),
      source: debugSource("raw-caustic"),
    });

    renderHost(gpu, host, 0);
    active = second;
    renderHost(gpu, host, 0);
    secondResult.resolve({ sources: {} });
    await settle();
    const callsAfterCurrent = requestRender.mock.calls.length;
    firstResult.resolve({ sources: {} });
    await settle();
    expect(requestRender).toHaveBeenCalledTimes(callsAfterCurrent);

    dispose(gpu, host);
  });

  test("does not wake a disposed host when async compilation settles", async () => {
    const gpu = await init();
    const pipeline = lightPipeline(gpu);
    const requestRender = vi.fn();
    const host = createHost(gpu, () => pipeline, requestRender);
    host.bridge.attachPreview({
      canvas: canvasLike(),
      source: debugSource("scene-hdr"),
    });
    renderHost(gpu, host, 0);
    const callsBeforeDispose = requestRender.mock.calls.length;
    host.dispose();
    await settle();
    expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
    gpu.dispose();
  });
});

function createHost(
  gpu: Gpu,
  getPipeline: () => PrismPipeline,
  invalidate = () => {}
) {
  const runtime = {
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
    }),
  } as PrismRuntime;
  return createPrismDebugPreviewHost({
    gpu,
    runtime,
    getPipeline,
    invalidate,
    onError(error) {
      throw error;
    },
  });
}

function lightPipeline(
  gpu: Gpu,
  createDebugDraws: () => Promise<PrismDebugDrawSet> = async () => ({
    sources: {},
  })
): DebuggableLightPipeline {
  const backdropHDR = target(gpu, { size: [16, 9], format: "rgba16float" });
  const sceneHDR = target(gpu, { size: [16, 9], format: "rgba16float" });
  return {
    mode: "light",
    debugTarget(sourceId) {
      if (sourceId === "backdrop-hdr") return { primary: backdropHDR };
      if (sourceId === "front-glass") {
        return {
          primary: sceneHDR,
          secondary: backdropHDR,
          mode: "difference",
        };
      }
      if (sourceId === "scene-hdr" || sourceId === "final-output")
        return { primary: sceneHDR };
      return undefined;
    },
    createDebugDraws,
    prepare: async () => {},
    resize: () => {},
    bind: () => {},
    render: () => {},
    destroy: () => {},
  };
}

function darkPipeline(gpu: Gpu): DebuggableTargetPipeline {
  const scene = target(gpu, { size: [16, 9], format: "rgba16float" });
  return {
    mode: "dark",
    debugTarget: (sourceId) =>
      sourceId === "dark-scene-hdr" ? { primary: scene } : undefined,
    prepare: async () => {},
    resize: () => {},
    bind: () => {},
    render: () => {},
    destroy: () => {},
  };
}

function renderHost(
  gpu: Gpu,
  host: ReturnType<typeof createPrismDebugPreviewHost>,
  time: number
): void {
  frame(gpu, (current) => host.render(current, time));
}

function dispose(
  gpu: Gpu,
  host: ReturnType<typeof createPrismDebugPreviewHost>
): void {
  host.dispose();
  gpu.dispose();
}

function debugSource(id: string): PrismDebugSource {
  return { id, label: id, kind: "view", inputs: [], visualization: "hdr" };
}

function canvasLike(): HTMLCanvasElement {
  const context = {
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({ createView: () => ({}) })),
  };
  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    clientWidth: 256,
    clientHeight: 144,
    getContext(kind: string) {
      return kind === "webgpu" ? { ...context, canvas } : null;
    },
    __context: context,
  };
  return canvas as unknown as HTMLCanvasElement;
}

function contextOf(canvas: HTMLCanvasElement) {
  return (
    canvas as unknown as {
      __context: {
        configure: ReturnType<typeof vi.fn>;
        unconfigure: ReturnType<typeof vi.fn>;
        getCurrentTexture: ReturnType<typeof vi.fn>;
      };
    }
  ).__context;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

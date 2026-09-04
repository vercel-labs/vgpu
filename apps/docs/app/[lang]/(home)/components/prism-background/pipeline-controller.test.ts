import { describe, expect, test, vi } from "vitest";

import { createPrismPipelineController } from "./pipeline-controller";
import type {
  PrismOutput,
  PrismPipeline,
  PrismPipelineMode,
  PrismPipelineQuality,
} from "./pipelines/types";
import type { PrismRuntime } from "./runtime/types";

const output = { size: [320, 180] } as unknown as PrismOutput;
const runtime = {} as PrismRuntime;

describe("async prism pipeline controller", () => {
  test.each(["dark", "light"] as const)(
    "loads and prepares only the initial %s factory",
    async (mode) => {
      const module = deferred<PrismPipeline>();
      const candidate = pipeline(mode);
      const factory = vi.fn(() => module.promise);
      const onActivate = vi.fn();
      const controller = createPrismPipelineController({
        runtime,
        output,
        initialMode: mode,
        createPipeline: factory,
        onActivate,
      });

      expect(factory).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledWith(mode, "high", runtime);
      expect(controller.pipeline).toBeUndefined();
      module.resolve(candidate.value);
      await controller.ready;

      expect(candidate.prepare).toHaveBeenCalledWith(output);
      expect(controller.pipeline).toBe(candidate.value);
      expect(onActivate).toHaveBeenCalledWith(mode, "high");
      controller.destroy();
    }
  );

  test("replaces the active pipeline when the requested quality changes", async () => {
    const high = pipeline("dark");
    const low = pipeline("dark");
    const factory = vi.fn(
      (_mode: PrismPipelineMode, quality: PrismPipelineQuality) =>
        quality === "high" ? high.value : low.value
    );
    const onActivate = vi.fn();
    const controller = createPrismPipelineController({
      runtime,
      output,
      initialMode: "dark",
      createPipeline: factory,
      onActivate,
    });
    await controller.ready;

    expect(controller.quality).toBe("high");
    await controller.setQuality("low");

    expect(factory).toHaveBeenLastCalledWith("dark", "low", runtime);
    expect(controller.pipeline).toBe(low.value);
    expect(controller.quality).toBe("low");
    expect(high.destroy).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenLastCalledWith("dark", "low");
    controller.destroy();
  });

  test("keeps the active pipeline through module load and candidate prepare", async () => {
    const lightModule = deferred<PrismPipeline>();
    const lightPrepare = deferred<void>();
    const dark = pipeline("dark");
    const light = pipeline("light", lightPrepare.promise);
    const factory = vi.fn((mode: PrismPipelineMode) =>
      mode === "dark" ? dark.value : lightModule.promise
    );
    const controller = createPrismPipelineController({
      runtime,
      output,
      initialMode: "dark",
      createPipeline: factory,
    });
    await controller.ready;

    const switching = controller.setMode("light");
    expect(controller.pipeline).toBe(dark.value);
    lightModule.resolve(light.value);
    await vi.waitFor(() => expect(light.prepare).toHaveBeenCalledOnce());
    expect(controller.pipeline).toBe(dark.value);
    expect(dark.destroy).not.toHaveBeenCalled();

    lightPrepare.resolve();
    await switching;
    expect(controller.pipeline).toBe(light.value);
    expect(dark.destroy).toHaveBeenCalledOnce();
    controller.destroy();
  });

  test("discards a stale module before preparing it", async () => {
    const lightModule = deferred<PrismPipeline>();
    const dark = pipeline("dark");
    const light = pipeline("light");
    const factory = vi.fn((mode: PrismPipelineMode) =>
      mode === "dark" ? dark.value : lightModule.promise
    );
    const controller = createPrismPipelineController({
      runtime,
      output,
      initialMode: "dark",
      createPipeline: factory,
    });
    await controller.ready;

    const switchToLight = controller.setMode("light");
    const keepDark = controller.setMode("dark");
    lightModule.resolve(light.value);
    await Promise.all([switchToLight, keepDark]);

    expect(controller.pipeline).toBe(dark.value);
    expect(light.prepare).not.toHaveBeenCalled();
    expect(light.destroy).toHaveBeenCalledOnce();
    expect(dark.destroy).not.toHaveBeenCalled();
    controller.destroy();
  });

  test("destroy waits for an in-flight module without touching dead runtime", async () => {
    const module = deferred<PrismPipeline>();
    const candidate = pipeline("light");
    const controller = createPrismPipelineController({
      runtime,
      output,
      initialMode: "light",
      createPipeline: () => module.promise,
    });

    const cleanup = controller.destroy();
    expect(cleanup).toBeInstanceOf(Promise);
    module.resolve(candidate.value);
    await Promise.all([controller.ready, cleanup]);

    expect(candidate.prepare).not.toHaveBeenCalled();
    expect(candidate.destroy).toHaveBeenCalledOnce();
    expect(controller.pipeline).toBeUndefined();
  });

  test("a failed candidate load preserves the active pipeline and can retry", async () => {
    const dark = pipeline("dark");
    const recovered = pipeline("light");
    let lightAttempts = 0;
    const factory = vi.fn((mode: PrismPipelineMode) => {
      if (mode === "dark") return dark.value;
      lightAttempts += 1;
      return lightAttempts === 1
        ? Promise.reject(new Error("light chunk unavailable"))
        : recovered.value;
    });
    const controller = createPrismPipelineController({
      runtime,
      output,
      initialMode: "dark",
      createPipeline: factory,
    });
    await controller.ready;

    await expect(controller.setMode("light")).rejects.toThrow(
      "light chunk unavailable"
    );
    expect(controller.pipeline).toBe(dark.value);
    expect(dark.destroy).not.toHaveBeenCalled();

    await controller.setMode("light");
    expect(controller.pipeline).toBe(recovered.value);
    expect(dark.destroy).toHaveBeenCalledOnce();
    controller.destroy();
  });
});

function pipeline(mode: PrismPipelineMode, ready = Promise.resolve()) {
  const prepare = vi.fn(() => ready);
  const destroy = vi.fn();
  const value: PrismPipeline = {
    mode,
    prepare,
    resize: vi.fn(),
    bind: vi.fn(),
    render: vi.fn(),
    destroy,
  };
  return { value, prepare, destroy };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

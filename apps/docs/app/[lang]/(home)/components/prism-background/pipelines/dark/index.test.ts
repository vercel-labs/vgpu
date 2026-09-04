import { describe, expect, test } from "vitest";
import { frame, init, target } from "vgpu/mock";

import { PRISM_DARK_DEBUG_SOURCE_IDS } from "../../debug/sources";
import type { EnvironmentTexture } from "../../environment/texture";
import { createDarkPipeline } from ".";
import { createPrismRuntime, destroyPrismRuntime } from "../../runtime/resources";
import { LOW_LIGHT_MESH_LAYOUT } from "../quality";

describe("dark pipeline debug targets", () => {
  test("falls back to single-sample HDR targets in compatibility mode", async () => {
    const gpu = await init();
    Object.defineProperty(gpu.device, "isCompatibilityMode", { value: true });
    const runtime = createPrismRuntime(gpu, [24, 16], "dark-compat-test");
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createDarkPipeline(runtime);
    runtime.studioEnvironment = {
      texture: gpu.device.createTexture({
        size: [2, 1],
        format: "rgba16float",
        usage: ["texture_binding", "copy_dst"],
      }),
      prepared: true,
    } as EnvironmentTexture;
    runtime.environmentReady = Promise.resolve();

    try {
      await pipeline.prepare(output);
      expect(pipeline.targets.backdropHDR?.sampleCount).toBe(1);
      expect(pipeline.targets.sceneHDR?.sampleCount).toBe(1);
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("removes far bloom and dedicated particle lighting in low quality", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "dark-low-test");
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createDarkPipeline(runtime, { quality: "low" });
    runtime.studioEnvironment = {
      texture: gpu.device.createTexture({
        size: [2, 1],
        format: "rgba16float",
        usage: ["texture_binding", "copy_dst"],
      }),
      prepared: true,
    } as EnvironmentTexture;
    runtime.environmentReady = Promise.resolve();

    try {
      await pipeline.prepare(output);
      expect(pipeline.lightMeshLayout).toBe(LOW_LIGHT_MESH_LAYOUT);
      expect(pipeline.targets.backdropHDR?.sampleCount).toBe(1);
      expect(pipeline.targets.sceneHDR?.sampleCount).toBe(4);
      expect(pipeline.debugTarget("dark-bloom-0")).toBeDefined();
      expect(pipeline.debugTarget("dark-bloom-1")).toBeDefined();
      expect(pipeline.debugTarget("dark-bloom-2")).toBeUndefined();
      expect(pipeline.debugTarget("dark-particle-light")).toBeUndefined();
      const profiledPasses: string[] = [];
      pipeline.bind(0);
      frame(gpu, (currentFrame) =>
        pipeline.render(currentFrame, output, {
          profile: {
            pass(name) {
              profiledPasses.push(name);
              return undefined;
            },
          },
        })
      );
      expect(profiledPasses).toEqual([
        "dark.backdrop",
        "dark.scene",
        "dark.bloom.extract",
        "dark.bloom.0.horizontal",
        "dark.bloom.0.vertical",
        "dark.bloom.1.horizontal",
        "dark.bloom.1.vertical",
        "dark.bloom.composite",
        "dark.present-cache",
        "dark.output",
      ]);
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("resolves retained production targets without changing the render graph", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "dark-debug-test");
    const environment = () =>
      ({
        texture: gpu.device.createTexture({
          size: [2, 1],
          format: "rgba16float",
          usage: ["texture_binding", "copy_dst"],
        }),
        prepared: true,
      } as EnvironmentTexture);
    runtime.studioEnvironment = environment();
    runtime.environmentReady = Promise.resolve();
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createDarkPipeline(runtime);

    try {
      expect(pipeline.debugSources?.().map(({ id }) => id)).toEqual(
        PRISM_DARK_DEBUG_SOURCE_IDS
      );
      expect(pipeline.debugTarget("dark-backdrop-hdr")).toBeUndefined();
      await pipeline.prepare(output);
      expect(pipeline.targets.backdropHDR?.sampleCount).toBe(1);
      expect(pipeline.targets.sceneHDR?.sampleCount).toBe(4);
      pipeline.bind(0);
      const profiledPasses: string[] = [];
      frame(gpu, (currentFrame) =>
        pipeline.render(currentFrame, output, {
          profile: {
            pass(name) {
              profiledPasses.push(name);
              return undefined;
            },
          },
        })
      );
      expect(profiledPasses).toEqual([
        "dark.backdrop",
        "dark.scene",
        "dark.bloom.extract",
        "dark.bloom.0.horizontal",
        "dark.bloom.0.vertical",
        "dark.bloom.1.horizontal",
        "dark.bloom.1.vertical",
        "dark.bloom.2.horizontal",
        "dark.bloom.2.vertical",
        "dark.particle-light.downsample",
        "dark.particle-light.3.horizontal",
        "dark.particle-light.3.vertical",
        "dark.bloom.composite",
        "dark.present-cache",
        "dark.output",
      ]);

      expect(pipeline.targets.presentationLDR?.size).toEqual([24, 16]);
      expect(pipeline.targets.presentationLDR?.format).toBe("rgba8unorm");
      expect(pipeline.targets.presentationLDR?.sampleCount).toBe(1);

      expect(pipeline.debugTarget("dark-backdrop-hdr")?.primary).toBe(
        pipeline.targets.backdropHDR
      );
      expect(pipeline.debugTarget("dark-scene-hdr")?.primary).toBe(
        pipeline.targets.sceneHDR
      );
      expect(pipeline.debugTarget("dark-presentation-ldr")?.primary).toBe(
        pipeline.targets.presentationLDR
      );
      expect(pipeline.debugTarget("dark-front-glass")).toEqual({
        primary: pipeline.targets.sceneHDR,
        secondary: pipeline.targets.backdropHDR,
        mode: "difference",
        differenceGain: 5,
      });

      const bloom0 = pipeline.debugTarget("dark-bloom-0")?.primary;
      const bloom1 = pipeline.debugTarget("dark-bloom-1")?.primary;
      const bloom2 = pipeline.debugTarget("dark-bloom-2")?.primary;
      const composite = pipeline.debugTarget("dark-bloom-composite")?.primary;
      const particle = pipeline.debugTarget("dark-particle-light")?.primary;
      expect(bloom0?.size).toEqual([12, 8]);
      expect(bloom1?.size).toEqual([6, 4]);
      expect(bloom2?.size).toEqual([3, 2]);
      expect(composite?.size).toEqual([12, 8]);
      expect(composite).not.toBe(bloom0);
      expect(particle?.size).toEqual([2, 1]);
      expect(pipeline.debugTarget("dark-bloom-3")).toBeUndefined();
      expect(pipeline.debugTarget("missing")).toBeUndefined();
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("builds an invalid presentation before retaining dust-only frames", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "dark-retained-test");
    runtime.studioEnvironment = {
      texture: gpu.device.createTexture({
        size: [2, 1],
        format: "rgba16float",
        usage: ["texture_binding", "copy_dst"],
      }),
      prepared: true,
    } as EnvironmentTexture;
    runtime.environmentReady = Promise.resolve();
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createDarkPipeline(runtime);

    const renderProfile = (updateScene: boolean): string[] => {
      const passes: string[] = [];
      pipeline.bind(1, { updateScene });
      frame(gpu, (currentFrame) =>
        pipeline.render(currentFrame, output, {
          updateScene,
          profile: {
            pass(name) {
              passes.push(name);
              return undefined;
            },
          },
        })
      );
      return passes;
    };

    try {
      await pipeline.prepare(output);
      expect(renderProfile(false)).toHaveLength(15);
      expect(renderProfile(false)).toEqual(["dark.output"]);

      pipeline.resize([32, 20]);
      expect(pipeline.targets.presentationLDR?.size).toEqual([32, 20]);
      expect(renderProfile(false)).toHaveLength(15);
    } finally {
      pipeline.destroy();
      expect(pipeline.targets.presentationLDR).toBeUndefined();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });
});

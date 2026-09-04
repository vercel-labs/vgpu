import { describe, expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { frame, init, target } from "vgpu/mock";

import { PRISM_DEBUG_SOURCE_IDS } from "../../debug/sources";
import { createLightGraph } from "./create-graph";
import { createLightPipeline, LIGHT_TARGET_COUNT } from ".";
import type { LightTextureLoader } from "./assets/loader";
import type { EnvironmentTexture } from "../../environment/texture";
import {
  destroyLightTargets,
  ensureLightTargets,
  resizeLightTargets,
} from "./targets";
import { createPrismRuntime, destroyPrismRuntime } from "../../runtime/resources";
import {
  lightCausticUniforms,
  lightPresentUniforms,
  lightWallUniforms,
} from "./uniforms";
import { LOW_LIGHT_MESH_LAYOUT } from "../quality";

describe("light pipeline ownership", () => {
  test("falls back to single-sample HDR targets in compatibility mode", async () => {
    const gpu = await init();
    Object.defineProperty(gpu.device, "isCompatibilityMode", { value: true });
    const runtime = createPrismRuntime(gpu, [80, 45], "light-compat-test");
    const graph = createLightGraph(runtime);
    try {
      ensureLightTargets(graph, runtime, runtime.outputSize);
      expect(graph.backdropHDR?.sampleCount).toBe(1);
      expect(graph.sceneHDR?.sampleCount).toBe(1);
    } finally {
      destroyLightTargets(graph);
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("keeps only the front-side HDR target multisampled", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [80, 45], "light-pipeline-test");
    const graph = createLightGraph(runtime);
    try {
      ensureLightTargets(graph, runtime, runtime.outputSize);
      const targets = [graph.backdropHDR, graph.sceneHDR];
      expect(LIGHT_TARGET_COUNT).toBe(2);
      expect(targets).toHaveLength(2);
      for (const target of targets) {
        expect(target?.format).toBe("rgba16float");
        expect(target?.size).toEqual([80, 45]);
      }
      expect(graph.backdropHDR?.sampleCount).toBe(1);
      expect(graph.sceneHDR?.sampleCount).toBe(4);
      expect(Object.keys(graph)).not.toEqual(
        expect.arrayContaining([
          "bloom",
          "bloomTargets",
          "dust",
          "particleLight",
        ])
      );
      expect(lightCausticUniforms(runtime)).toEqual(
        expect.objectContaining({
          strength: 1.9,
          coverage: 0.86,
          normalInfluence: 1,
          normalElevation: 35,
          materialWorldScale: 0.57 * 2.4,
          normalStrength: 0.22 * 0.6,
          microNormalFrequency: 7,
          microNormalStrength: 1.05 * 0.6,
          farDesaturation: 0.04,
          farBrightness: 0.02,
          travelScale: 1,
          falloffRateScale: 0.12,
          falloffPowerScale: 0.5,
        })
      );
      expect(lightWallUniforms(runtime)).toEqual(
        expect.objectContaining({
          materialWorldScale: 0.57 * 2.4,
          normalStrength: 0.22 * 0.6,
          microNormalFrequency: 7,
          microNormalStrength: 1.05 * 0.6,
          ambient: 0.5,
          lightDirection: [-0.48, 0.56, 0.68],
          ambientLightStrength: 0.42,
          globalLightTransfer: 0.65,
          shadowContrast: 6.85,
          shadowPivot: 0.9,
          shadowFloor: 0.87,
          highlightExposure: 3.31,
          prismShadowStrength: 0,
        })
      );
      expect(lightPresentUniforms(runtime)).toEqual({
        backgroundColor: [250 / 255, 250 / 255, 250 / 255],
        exposure: 1,
        revealProgress: 1,
        toneMapping: 0,
      });
      runtime.controls = {
        ...runtime.controls,
        lightMode: {
          wall: {
            normalStrength: 1.5,
            lightmapGamma: 3,
            shadowContrast: 4,
            shadowPivot: 0.42,
            shadowFloor: 0.35,
            highlightExposure: 0.9,
            ambientFill: 0.8,
          },
          caustic: {
            strength: 2.4,
            coverage: 0.65,
            normalInfluence: 0.8,
            normalElevation: 52,
          },
          output: { exposure: 0.75, toneMapping: "neutral" },
        },
      };
      expect(lightWallUniforms(runtime)).toEqual(
        expect.objectContaining({
          normalStrength: 0.22 * 1.5,
          microNormalStrength: 1.05 * 1.5,
          globalLightTransfer: 3,
          shadowContrast: 4,
          shadowPivot: 0.42,
          shadowFloor: 0.35,
          highlightExposure: 0.9,
          ambientLightStrength: 0.8,
        })
      );
      expect(lightCausticUniforms(runtime)).toEqual(
        expect.objectContaining({
          strength: 2.4,
          coverage: 0.65,
          normalInfluence: 0.8,
          normalElevation: 52,
        })
      );
      expect(lightPresentUniforms(runtime)).toEqual({
        backgroundColor: [250 / 255, 250 / 255, 250 / 255],
        exposure: 0.75,
        revealProgress: 1,
        toneMapping: 1,
      });
      await graph.caustic.compile(graph.backdropHDR!);
      const causticPipeline = getMockGPUDeviceInstrumentation(
        gpu.device.gpu
      ).createRenderPipelineAsyncDescriptors.at(-1);
      const causticTarget = Array.from(
        causticPipeline?.fragment?.targets ?? []
      )[0];
      expect(causticTarget?.blend?.color).toEqual({
        srcFactor: "one",
        dstFactor: "one",
        operation: "add",
      });
      resizeLightTargets(graph, [101, 57]);
      expect(graph.backdropHDR?.size).toEqual([101, 57]);
      expect(graph.sceneHDR?.size).toEqual([101, 57]);
    } finally {
      destroyLightTargets(graph);
      graph.prismShadowGeometry.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("keeps front-side MSAA and the simplified wall in low quality", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [80, 45], "light-low-test");
    const graph = createLightGraph(runtime, "low");
    try {
      ensureLightTargets(graph, runtime, runtime.outputSize);
      expect(graph.simplifiedWall).toBe(true);
      expect(graph.lightMeshLayout).toBe(LOW_LIGHT_MESH_LAYOUT);
      expect(graph.backdropHDR?.sampleCount).toBe(1);
      expect(graph.sceneHDR?.sampleCount).toBe(4);
      await graph.wall.compile(graph.backdropHDR!);
    } finally {
      destroyLightTargets(graph);
      graph.prismShadowGeometry.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("exposes the stable debug graph without allocating debug targets", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [16, 9], "light-debug-test");
    try {
      const pipeline = createLightPipeline(runtime);
      expect(pipeline.debugSources?.().map((source) => source.id)).toEqual(
        PRISM_DEBUG_SOURCE_IDS
      );
      expect(pipeline.targets).toEqual({
        backdropHDR: undefined,
        sceneHDR: undefined,
      });
      expect(pipeline.debugTarget("backdrop-hdr")).toBeUndefined();
      pipeline.destroy();
    } finally {
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("prepares and encodes the complete two-pass graph", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-compile-test");
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
    const assetLoader: LightTextureLoader = {
      async load(currentGpu, spec) {
        const texture = currentGpu.device.createTexture({
          size: [1, 1],
          format: "rgba8unorm",
          usage: ["texture_binding", "copy_dst"],
          label: spec.id,
        });
        currentGpu.gpu.queue.writeTexture(
          { texture: texture.gpu },
          new Uint8Array([255, 128, 128, 255]),
          { bytesPerRow: 4, rowsPerImage: 1 },
          [1, 1, 1]
        );
        return texture;
      },
    };
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createLightPipeline(runtime, { assetLoader });
    try {
      await pipeline.prepare(output);
      const debug = await pipeline.createDebugDraws();
      expect(await pipeline.createDebugDraws()).toBe(debug);
      expect(debug.sources["prism-shadow"]).toBeDefined();
      await Promise.all(
        Object.values(debug.sources).map((drawable) =>
          drawable!.compile(output)
        )
      );
      pipeline.bind(0);
      frame(gpu, (currentFrame) => pipeline.render(currentFrame, output));
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
        "light.backdrop",
        "light.scene",
        "light.present",
      ]);
      expect(pipeline.targets.backdropHDR?.size).toEqual(output.size);
      expect(pipeline.targets.sceneHDR?.size).toEqual(output.size);
      expect(pipeline.debugTarget("backdrop-hdr")?.primary).toBe(
        pipeline.targets.backdropHDR
      );
      expect(pipeline.debugTarget("scene-hdr")?.primary).toBe(
        pipeline.targets.sceneHDR
      );
      expect(pipeline.debugTarget("final-output")).toEqual({
        primary: pipeline.targets.sceneHDR,
        exposure: 1,
        toneMapping: 0,
      });
      expect(pipeline.debugTarget("front-glass")).toEqual({
        primary: pipeline.targets.sceneHDR,
        secondary: pipeline.targets.backdropHDR,
        mode: "difference",
        differenceGain: 5,
      });
      expect(pipeline.debugTarget("missing")).toBeUndefined();
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("waits for environment work before surfacing an asset failure", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-asset-failure");
    const environment = deferred<void>();
    const assetFailure = new Error("asset upload failed");
    runtime.environmentReady = environment.promise;
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createLightPipeline(runtime, {
      assetLoader: {
        async load() {
          throw assetFailure;
        },
      },
    });
    let settled = false;
    const preparing = pipeline.prepare(output).finally(() => {
      settled = true;
    });
    try {
      await settleMicrotasks();
      expect(settled).toBe(false);
      // Graph compilation no longer waits behind either asset loading or the
      // environment bake. Debug-only wireframes are absent from this inventory.
      expect(
        getMockGPUDeviceInstrumentation(gpu.device.gpu)
          .createRenderPipelineAsyncDescriptors
      ).toHaveLength(8);

      environment.resolve();
      await expect(preparing).rejects.toBe(assetFailure);
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("destroys fulfilled assets exactly once when environment preparation fails", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-env-failure");
    const environmentFailure = new Error("environment bake failed");
    runtime.environmentReady = Promise.reject(environmentFailure);
    const destroys = [vi.fn(), vi.fn(), vi.fn()];
    let assetIndex = 0;
    const output = target(gpu, { size: [24, 16], format: "rgba8unorm" });
    const pipeline = createLightPipeline(runtime, {
      assetLoader: {
        async load() {
          return { destroy: destroys[assetIndex++]! } as never;
        },
      },
    });
    try {
      await expect(pipeline.prepare(output)).rejects.toBe(environmentFailure);
      for (const destroy of destroys) expect(destroy).toHaveBeenCalledOnce();

      pipeline.destroy();
      for (const destroy of destroys) expect(destroy).toHaveBeenCalledOnce();
    } finally {
      pipeline.destroy();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

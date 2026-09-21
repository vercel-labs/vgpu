import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, test, vi } from "vitest";
import type { Gpu } from "vgpu";
import type { Texture } from "vgpu/core";

import causticDebugWgsl from "../passes/caustic/caustic-debug.wgsl";
import causticWgsl from "../passes/caustic/caustic.wgsl";
import copyLinearWgsl from "../../shared/presentation/copy-linear.wgsl";
import presentWgsl from "../passes/presentation/present.wgsl";
import spectralWgsl from "../../shared/spectral/spectral.wgsl";
import toneMappingWgsl from "../../shared/presentation/tone-mapping.wgsl";
import wallCommonWgsl from "../passes/wall/wall-common.wgsl";
import wallDebugWgsl from "../passes/wall/wall-debug.wgsl";
import wallLowWgsl from "../passes/wall/wall-low.wgsl";
import wallNormalWgsl from "../passes/wall/wall-normal.wgsl";
import wallWgsl from "../passes/wall/wall.wgsl";
import { bakeLightAssetTextures } from "./bake";
import bakeWgsl from "./bake.wgsl";
import downsampleWgsl from "./downsample.wgsl";
import { generateCausticProfile } from "./generate-caustic";
import {
  applyGlobalLightMask,
  generateLightAsset,
  globalLightMaskEdgeMax,
} from "./generate";
import {
  generateWallLighting,
  generateWallMaterial,
  PRISM_GROUNDING_AO,
  PRISM_GROUNDING_TRIANGLE,
} from "./generate-wall";
import {
  createLightTextureLoader,
  loadLightAssetTextures,
  type LightTextureLoader,
} from "./loader";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { wavelengthToBeamRgb } from "../../../scene/optics";
import { PRISM_SPECTRAL_SAMPLES, PRISM_WAVELENGTHS } from "../../../types";

describe("light pipeline baked assets", () => {
  test("spectral LUT is the Float32 checkpoint of the CPU CIE/D65 formula", () => {
    const entries = Array.from(
      spectralWgsl.wgsl.matchAll(/vec4f\(([^)]+)\),/g),
      (match) => match[1]!.split(",").map((value) => Number(value.trim()))
    );
    expect(entries).toHaveLength(PRISM_SPECTRAL_SAMPLES);

    entries.forEach((entry, index) => {
      const wavelength = Math.fround(
        PRISM_WAVELENGTHS.min +
          (PRISM_WAVELENGTHS.max - PRISM_WAVELENGTHS.min) *
            (index / (PRISM_SPECTRAL_SAMPLES - 1))
      );
      expect(entry).toEqual([
        ...wavelengthToBeamRgb(wavelength).map(Math.fround),
        wavelength,
      ]);
    });
  });

  test("wall grounding uses the exact prism footprint", () => {
    const [apex, left, right] = PRISM_GROUNDING_TRIANGLE;
    expect(apex[0]).toBeCloseTo(0);
    expect(left[0]).toBeCloseTo(-0.5);
    expect(right[0]).toBeCloseTo(0.5);
    expect(left[1]).toBeCloseTo(right[1]);
    expect(left[1] - apex[1]).toBeCloseTo(Math.sqrt(3) / 2);
    expect(PRISM_GROUNDING_AO.insideSpread).toBeLessThan(
      PRISM_GROUNDING_AO.outsideSpread
    );
    expect(PRISM_GROUNDING_AO.opacity).toBeLessThan(0.12);
  });

  test("procedural sources are deterministic and retain useful variation", () => {
    const first = generateWallMaterial([24, 16]);
    const second = generateWallMaterial([24, 16]);
    expect(first.pixels).toEqual(second.pixels);
    expect(
      new Set(first.pixels.filter((_, index) => index % 4 === 0)).size
    ).toBeGreaterThan(8);

    const caustic = generateCausticProfile([32, 12]);
    expect(new Set(caustic.pixels).size).toBeGreaterThan(32);
  });

  test("wall lighting bakes three positive soft light fields", () => {
    const lighting = generateWallLighting([64, 64]);
    const channelAt = (u: number, v: number, channel: number) => {
      const x = Math.floor(u * lighting.width);
      const y = Math.floor(v * lighting.height);
      return lighting.pixels[(y * lighting.width + x) * 4 + channel]!;
    };
    const redAt = (u: number, v: number) => channelAt(u, v, 0);
    const quiet = redAt(0.12, 0.92);

    expect(redAt(0.02, 0.02)).toBeGreaterThan(quiet + 25);
    expect(redAt(0.56, 0.25)).toBeGreaterThan(quiet + 18);
    expect(redAt(0.82, 0.48)).toBeGreaterThan(quiet + 12);
    expect(channelAt(0.75, 0.25, 1)).toBe(255);
    expect(channelAt(0.5, 0.645, 1)).toBeLessThan(255);
    expect(channelAt(0.5, 0.72, 1)).toBe(255);
  });

  test("ships only a small authored wall mask and bakes the textures on the GPU", async () => {
    const mask = PNG.sync.read(
      await readFile(
        resolve(
          process.cwd(),
          "apps/docs/assets/prism-light/wall-global-light-mask.png"
        )
      )
    );
    const generated = generateLightAsset("wall-lighting");
    applyGlobalLightMask(
      generated,
      mask.data,
      mask.width,
      mask.height
    );
    expect(mask.width / mask.height).toBeCloseTo(1.5);
    expect(
      globalLightMaskEdgeMax(
        generated.pixels,
        generated.width,
        generated.height,
        1
      )
    ).toBeLessThanOrEqual(2);

    const webp = await readFile(
      resolve(
        process.cwd(),
        "apps/docs/public/hero/prism-light/wall-global-light-mask.webp"
      )
    );
    expect(webp.subarray(0, 4).toString()).toBe("RIFF");
    expect(webp.subarray(8, 12).toString()).toBe("WEBP");
    expect(webp.byteLength).toBeLessThan(20_000);

    expect(
      reflectSource(bakeWgsl.wgsl).entryPoints.map((entry) => entry.name)
    ).toEqual(
      expect.arrayContaining([
        "wall_material",
        "wall_lighting",
        "wall_lighting_fallback",
        "caustic_profile",
      ])
    );
    expect(
      reflectSource(downsampleWgsl.wgsl).entryPoints.map((entry) => entry.name)
    ).toEqual(["main"]);
  });

  test("starts every compute pipeline compilation without a serial wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline")))
    );
    const failure = new Error("stop after observing concurrent compilation");
    let rejectFirst!: (reason: Error) => void;
    const firstPipeline = new Promise<GPUComputePipeline>(
      (_resolve, reject) => {
        rejectFirst = reject;
      }
    );
    const createComputePipelineAsync = vi.fn(
      (descriptor: GPUComputePipelineDescriptor) =>
        createComputePipelineAsync.mock.calls.length === 1
          ? firstPipeline
          : Promise.resolve({} as GPUComputePipeline)
    );
    const currentGpu = {
      gpu: {
        createShaderModule: vi.fn(() => ({})),
        createComputePipelineAsync,
      },
    } as unknown as Gpu;

    try {
      const baking = bakeLightAssetTextures(currentGpu);
      await vi.waitFor(() =>
        expect(createComputePipelineAsync).toHaveBeenCalledTimes(4)
      );
      expect(
        createComputePipelineAsync.mock.calls.map(
          ([descriptor]) => descriptor.compute.entryPoint
        )
      ).toEqual([
        "wall_material",
        "caustic_profile",
        "main",
        "wall_lighting_fallback",
      ]);
      rejectFirst(failure);
      await expect(baking).rejects.toBe(failure);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("debug shaders publish every material inspection entry", () => {
    const wallEntries = reflectSource(wallDebugWgsl.wgsl).entryPoints.map(
      (entry) => entry.name
    );
    expect(wallEntries).toEqual(
      expect.arrayContaining([
        "vs_debug",
        "fs_albedo",
        "fs_large_normal",
        "fs_micro_normal",
        "fs_normal",
        "fs_roughness",
        "fs_global_shadow",
        "fs_prism_shadow",
        "fs_prism_ao",
        "fs_composed",
      ])
    );
    expect(wallDebugWgsl.wgsl).toContain(
      "params.viewProjection * vec4f(worldPosition, 0.0, 1.0)"
    );
    expect(
      reflectSource(causticDebugWgsl.wgsl).entryPoints.map(
        (entry) => entry.name
      )
    ).toContain("fs_raw_caustic");
    expect(spectralWgsl.wgsl).toContain("SPECTRAL_LUT");
    expect(spectralWgsl.wgsl).not.toContain("d65SpectralPower");
  });

  test("wall detail is world-space, isotropic, and split into two normal scales", () => {
    expect(wallNormalWgsl.wgsl).toContain(
      "worldPosition / max(worldScale, 0.001)"
    );
    expect(wallCommonWgsl.wgsl).toContain("params.microNormalFrequency");
    expect(wallCommonWgsl.wgsl).toContain("params.microNormalStrength");
    expect(wallNormalWgsl.wgsl).toContain("textureSampleBias");
    expect(wallCommonWgsl.wgsl).toContain("GLOBAL_LIGHT_MASK_ASPECT = 1.5");
    expect(wallCommonWgsl.wgsl).toMatch(
      /wallAspect \/ \w*GLOBAL_LIGHT_MASK_ASPECT/
    );
    expect(wallCommonWgsl.wgsl).toMatch(
      /screenUv\.y \* \w*GLOBAL_LIGHT_MASK_ASPECT \/ wallAspect/
    );
    expect(wallCommonWgsl.wgsl).toContain(
      "material.r * globalDiffuse"
    );
    expect(wallCommonWgsl.wgsl).toContain("mix(0.25, 1.0, lightFacing)");
    expect(wallCommonWgsl.wgsl).toContain("params.globalLightTransfer");
    expect(wallCommonWgsl.wgsl).toContain("globalLightLinear");
    expect(wallCommonWgsl.wgsl).toContain("shadowContrastCurve");
    expect(wallCommonWgsl.wgsl).toContain("params.shadowContrast");
    expect(wallCommonWgsl.wgsl).toContain("params.shadowPivot");
    expect(wallCommonWgsl.wgsl).toContain("globalLightShaped");
    expect(wallCommonWgsl.wgsl).toContain("globalBaseExposure");
    expect(wallCommonWgsl.wgsl).toContain(
      "direct * globalBaseExposure + globalIllumination"
    );
    expect(wallCommonWgsl.wgsl).toContain("globalSurfaceResponse");
    expect(wallCommonWgsl.wgsl).not.toContain("albedo * globalLight");
    expect(wallCommonWgsl.wgsl).not.toContain(
      "textureSample(wallMaterial, materialSampler, screenUv)"
    );
    expect(wallLowWgsl.wgsl).toContain("shadowContrastCurve");
    expect(wallLowWgsl.wgsl).toContain("params.shadowContrast");
    expect(wallLowWgsl.wgsl).toContain("params.shadowPivot");
    expect(wallLowWgsl.wgsl).toContain("globalLightShaped");
    expect(wallLowWgsl.wgsl).toContain("wallMaterial");
    expect(wallLowWgsl.wgsl).toContain("material.gb");
    expect(wallLowWgsl.wgsl).toContain("params.normalStrength");
    expect(
      wallLowWgsl.wgsl.match(/textureSample\(\s*wallMaterial/g)
    ).toHaveLength(1);
    expect(wallLowWgsl.wgsl).not.toContain("evaluateWallNormals");
    expect(wallLowWgsl.wgsl).not.toContain("params.microNormalStrength");
    expect(wallLowWgsl.wgsl).not.toContain("specular");
    expect(wallDebugWgsl.wgsl).toContain("tonemapAces(composed)");
    expect(wallDebugWgsl.wgsl).toContain("linearToSrgb3(");
  });

  test("caustic output is non-darkening premultiplied radiance", () => {
    expect(causticWgsl.wgsl).toContain(
      "vec4f(tint * coverage * surfaceResponse, 0.0)"
    );
    expect(causticWgsl.wgsl).toContain(
      "vec4f(position, scene.lightPlaneZ, 1.0)"
    );
    expect(causticWgsl.wgsl).not.toContain("select(0.0, scene.lightPlaneZ");
    expect(causticWgsl.wgsl).toContain("scene.inputBeamDirection");
    expect(causticWgsl.wgsl).toContain(
      "rayDirection * cos(elevation)"
    );
    expect(causticWgsl.wgsl).not.toContain(
      "-rayDirection * cos(elevation)"
    );
    expect(causticWgsl.wgsl).toContain("hasTravelGradient");
    expect(causticWgsl.wgsl).toContain(
      "in.wavelength >= 0.0 && hasTravelGradient"
    );
    expect(causticWgsl.wgsl).not.toContain(
      "in.wavelength < 0.0 || hasTravelGradient"
    );
    expect(causticWgsl.wgsl).toContain("relativeResponse");
    expect(wallNormalWgsl.wgsl).toContain("textureSampleLevel");
  });

  test("light present supports selectable tone mapping", () => {
    expect(presentWgsl.wgsl).toContain("params.toneMapping");
    expect(presentWgsl.wgsl).toContain("applyPrismToneMapping");
    expect(presentWgsl.wgsl).toContain(
      "mix(params.backgroundColor, presented, reveal)"
    );
    expect(toneMappingWgsl.wgsl).toContain("tonemapAces");
    expect(toneMappingWgsl.wgsl).toContain("tonemapNeutral");
    expect(toneMappingWgsl.wgsl).toContain("tonemapReinhard");
    expect(toneMappingWgsl.wgsl).toContain("mode == 3u");
  });

  test("keeps production targets linear HDR until presentation", () => {
    expect(wallWgsl.wgsl).not.toContain("tonemap");
    expect(wallWgsl.wgsl).not.toContain("linearToSrgb");
    expect(copyLinearWgsl.wgsl).not.toContain("tonemap");
    expect(copyLinearWgsl.wgsl).not.toContain("linearToSrgb");
    expect(presentWgsl.wgsl).toContain("applyPrismToneMapping");
    expect(presentWgsl.wgsl).toContain("linearToSrgb3");
  });

  test("destroys successful texture loads when one asset fails", async () => {
    const destroyed = [vi.fn(), vi.fn()];
    let successful = 0;
    const loader: LightTextureLoader = {
      async load(_gpu, spec) {
        if (spec.id === "caustic-profile") throw new Error("broken caustic");
        return { destroy: destroyed[successful++]! } as unknown as Texture;
      },
    };
    await expect(loadLightAssetTextures({} as Gpu, loader)).rejects.toThrow(
      "broken caustic"
    );
    for (const destroy of destroyed) expect(destroy).toHaveBeenCalledOnce();
  });

  test("destroys a partial GPU upload without retrying doomed bytes", async () => {
    const destroy = vi.fn();
    const createTexture = vi.fn(() => ({ gpu: {}, destroy }));
    const writeTexture = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("device upload failed");
      });
    const loader = createLightTextureLoader({
      fallback: () => ({
        width: 2,
        height: 2,
        pixels: new Uint8Array(16),
      }),
    });
    const gpu = {
      device: { createTexture },
      gpu: { queue: { writeTexture } },
    } as unknown as Gpu;

    await expect(
      loader.load(gpu, {
        id: "wall-material",
        size: [2, 2],
      })
    ).rejects.toThrow("device upload failed");
    expect(createTexture).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

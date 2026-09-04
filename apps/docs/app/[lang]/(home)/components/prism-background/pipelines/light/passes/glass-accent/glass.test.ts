import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { describe, expect, test } from "vitest";
import { init, target } from "vgpu/mock";

import glassAccentWgsl from "./glass-accent.wgsl";
import glassGroundingWgsl from "../../shared/glass-grounding.wgsl";
import wallCommonWgsl from "../wall/wall-common.wgsl";
import { createLightGraph } from "../../create-graph";
import { lightGlassAccentUniforms } from "./uniforms";
import { createPrismRuntime, destroyPrismRuntime } from "../../../../runtime/resources";
import { glassUniforms } from "../../../../runtime/uniforms";

describe("light glass accent", () => {
  test("keeps broad reflection and bevel controls localized to light mode", () => {
    expect(lightGlassAccentUniforms()).toEqual({
      bandCenter: 0.052,
      bandWidth: 0.034,
      bandStrength: 0.52,
      baseReflection: 0.05,
      rimStrength: 0.45,
      baseRimStrength: 0.28,
      environmentLodBias: 1.6,
      highlightStrength: 0.95,
    });
    expect(
      reflectSource(glassAccentWgsl.wgsl).entryPoints.map((entry) => entry.name)
    ).toEqual(expect.arrayContaining(["vs_main", "fs_main"]));
    expect(glassAccentWgsl.wgsl).toContain("innerBand");
    expect(glassAccentWgsl.wgsl).toContain("frontRim");
    expect(glassAccentWgsl.wgsl).toContain("baseRim");
    expect(glassGroundingWgsl.wgsl).toContain("pow(clamp(prismShadow");
    expect(wallCommonWgsl.wgsl).toContain("evaluateGlassGrounding");
  });

  test("maximizes environment reflections only in the light pipeline", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-reflection-test");
    try {
      expect(glassUniforms(runtime, "light")).toEqual(
        expect.objectContaining({
          reflectionStrength: 3,
          environmentExposure: 4,
        })
      );
      expect(glassUniforms(runtime, "dark")).toEqual(
        expect.objectContaining({
          reflectionStrength: 2.14,
          environmentExposure: 2.3,
        })
      );
    } finally {
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });

  test("uses premultiplied compositing without adding a render target", async () => {
    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-glass-test");
    const graph = createLightGraph(runtime);
    const output = target(gpu, {
      size: [24, 16],
      format: "rgba16float",
      msaa: 4,
    });
    try {
      await graph.glassAccent.compile(output);
      const descriptor = getMockGPUDeviceInstrumentation(
        gpu.device.gpu
      ).createRenderPipelineAsyncDescriptors.at(-1);
      const colorTarget = Array.from(descriptor?.fragment?.targets ?? [])[0];
      expect(colorTarget?.blend?.color).toEqual({
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      });
    } finally {
      graph.prismShadowGeometry.destroy();
      (output as typeof output & { destroy?: () => void }).destroy?.();
      destroyPrismRuntime(runtime);
      gpu.dispose();
    }
  });
});

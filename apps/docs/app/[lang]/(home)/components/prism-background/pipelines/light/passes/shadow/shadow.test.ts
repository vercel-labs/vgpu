import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { describe, expect, test } from "vitest";
import { init, target } from "vgpu/mock";

import shadowWgsl from "./shadow.wgsl";
import { PRISM_DEBUG_SOURCES } from "../../../../debug/sources";
import { createLightGraph } from "../../create-graph";
import { buildShadowMesh } from "./mesh";
import { LIGHT_SHADOW_TUNING } from "./tuning";
import { createPrismRuntime, destroyPrismRuntime } from "../../../../runtime/resources";
import { PRISM_TRIANGLE } from "../../../../types";

describe("analytic prism cast shadow", () => {
  test("sweeps the silhouette into one core plus two soft vertex rings", () => {
    const mesh = buildShadowMesh(PRISM_TRIANGLE, LIGHT_SHADOW_TUNING);
    const count = mesh.hull.length;
    const vertex = (index: number) =>
      Array.from(mesh.vertices.slice(index * 4, index * 4 + 4));

    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(5);
    expect(mesh.vertices).toHaveLength((1 + count * 3) * 4);
    expect(mesh.indices).toHaveLength(count * 15);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.indices.byteLength % 4).toBe(0);
    expect(new Set(mesh.hullTravel)).toEqual(new Set([0, 1]));

    const coreStart = 1;
    const middleStart = coreStart + count;
    const outerStart = middleStart + count;
    for (let index = 0; index < count; index += 1) {
      expect(vertex(coreStart + index)[2]).toBe(1);
      expect(vertex(middleStart + index)[2]).toBeCloseTo(
        LIGHT_SHADOW_TUNING.midCoverage
      );
      expect(vertex(outerStart + index)[2]).toBe(0);
    }

    const penumbraWidth = (index: number) => {
      const core = vertex(coreStart + index);
      const outer = vertex(outerStart + index);
      return Math.hypot(outer[0]! - core[0]!, outer[1]! - core[1]!);
    };
    const nearWidths = mesh.hullTravel
      .map((travel, index) => (travel === 0 ? penumbraWidth(index) : 0))
      .filter(Boolean);
    const farWidths = mesh.hullTravel
      .map((travel, index) => (travel === 1 ? penumbraWidth(index) : 0))
      .filter(Boolean);
    expect(Math.min(...farWidths)).toBeGreaterThan(Math.max(...nearWidths));

    for (let index = 0; index < mesh.indices.length; index += 3) {
      const a = vertex(mesh.indices[index]!);
      const b = vertex(mesh.indices[index + 1]!);
      const c = vertex(mesh.indices[index + 2]!);
      const signedArea =
        (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
      expect(signedArea).toBeGreaterThan(0);
    }
  });

  test("uses premultiplied darkening and exposes an isolated debug entry", async () => {
    expect(
      reflectSource(shadowWgsl.wgsl).entryPoints.map((entry) => entry.name)
    ).toEqual(expect.arrayContaining(["vs_main", "fs_main", "fs_debug"]));
    expect(PRISM_DEBUG_SOURCES.find(({ id }) => id === "prism-shadow")).toEqual(
      expect.objectContaining({
        label: "Prism shadow draw",
        kind: "draw",
        visualization: "scalar",
      })
    );

    const gpu = await init();
    const runtime = createPrismRuntime(gpu, [24, 16], "light-shadow-test");
    const graph = createLightGraph(runtime);
    const output = target(gpu, {
      size: [24, 16],
      format: "rgba16float",
      msaa: 4,
    });
    try {
      await graph.prismShadow.compile(output);
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

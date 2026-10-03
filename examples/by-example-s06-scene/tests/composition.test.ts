import { describe, expect, test } from "vitest";
import { init } from "vgpu/node";
import {
  createCompositionExample,
  type CompositionExample,
  type CompositionPath,
} from "../src/composition.ts";

const native = process.env.VGPU_DOCKER_TEST === "1";
const paths = ["groups", "hierarchy", "final-worlds"] as const satisfies readonly CompositionPath[];

describe.skipIf(!native)("scene composition native fixture", () => {
  test("groups, external hierarchy arrays, and final worlds render equivalent transforms and attributes in two passes", async () => {
    const gpu = await init();
    try {
      const examples = paths.map((path) => createCompositionExample(gpu, path));
      const outputs = await Promise.all(examples.map(renderAndRead));

      for (const output of outputs) {
        expect(output.count).toBe(3);
        expect(uniqueCovered(output.positions)).toEqual([
          [-1.5, -0.5, 0, 1],
          [0, 0, 0, 1],
          [1.5, 0.5, 0, 1],
        ]);
        expect(uniqueCovered(output.colors)).toEqual([
          [0.25, 0.5, 1, 101],
          [0.5, 1, 0.25, 202],
          [1, 0.25, 0.5, 303],
        ]);
      }

      expect(outputs[1]!.positions).toEqual(outputs[0]!.positions);
      expect(outputs[1]!.colors).toEqual(outputs[0]!.colors);
      expect(outputs[2]!.positions).toEqual(outputs[0]!.positions);
      expect(outputs[2]!.colors).toEqual(outputs[0]!.colors);
    } finally {
      gpu.dispose();
    }
  });

  test("parent movement reaches every descendant and external output reset requires a full evaluation", async () => {
    const gpu = await init();
    try {
      const examples = paths.map((path) => createCompositionExample(gpu, path));
      for (const example of examples) expect(example.moveRoot([-1.25, -0.25, 0])).toBe(3);

      const hierarchy = examples[1]!;
      expect(hierarchy.updatedRows()).toEqual(new Uint8Array([1, 1, 1]));
      expect(hierarchy.resetExternalWorlds()).toBe(3);
      expect(hierarchy.updatedRows()).toEqual(new Uint8Array([1, 1, 1]));

      const outputs = await Promise.all(examples.map(renderAndRead));
      for (const output of outputs) {
        expect(uniqueCovered(output.positions)).toEqual([
          [-1.25, -0.25, 0, 1],
          [0.25, 0.25, 0, 1],
          [1.75, 0.75, 0, 1],
        ]);
      }
      expect(outputs[1]!.positions).toEqual(outputs[0]!.positions);
      expect(outputs[2]!.positions).toEqual(outputs[0]!.positions);
    } finally {
      gpu.dispose();
    }
  });

  test("mutating camera arrays does not refresh uniforms until the named camera binding is set again", async () => {
    const gpu = await init();
    try {
      const example = createCompositionExample(gpu, "final-worlds");
      const initial = await renderAndRead(example);
      const initialViewProjection = new Float32Array(example.matrices.viewProjection);

      example.moveCameraWithoutUpload([4, 2, 6]);
      expect(example.matrices.viewProjection).not.toEqual(initialViewProjection);
      const stale = await renderAndRead(example);
      expect(stale.positions).toEqual(initial.positions);

      example.uploadCamera();
      const refreshed = await renderAndRead(example);
      expect(refreshed.positions).not.toEqual(initial.positions);
      expect(uniqueCovered(refreshed.positions)).toEqual(uniqueCovered(initial.positions));
    } finally {
      gpu.dispose();
    }
  });

  test("publishing and drawing an empty collection uses an explicit zero instance count", async () => {
    const gpu = await init();
    try {
      const example = createCompositionExample(gpu, "final-worlds");
      expect(example.clear()).toBe(0);
      const output = await renderAndRead(example);
      expect(output.count).toBe(0);
      expect(output.positions.every((value) => value === 0)).toBe(true);
      expect(output.colors.every((value) => value === 0)).toBe(true);
    } finally {
      gpu.dispose();
    }
  });
});

async function renderAndRead(example: CompositionExample) {
  const count = example.render();
  return {
    count,
    positions: await example.positionTarget.color.readFloats({ mipLevel: 0, region: "all" }),
    colors: await example.colorTarget.color.readFloats({ mipLevel: 0, region: "all" }),
  };
}

function uniqueCovered(pixels: Float32Array): number[][] {
  const values = new Map<string, number[]>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const pixel = Array.from(pixels.subarray(offset, offset + 4), rounded);
    if (pixel[3] === 0) continue;
    values.set(pixel.join(","), pixel);
  }
  return [...values.values()].sort((a, b) => a[0]! - b[0]!);
}

function rounded(value: number): number {
  return Math.abs(value) < 1e-5 ? 0 : Number(value.toFixed(4));
}

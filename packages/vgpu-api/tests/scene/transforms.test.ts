import { describe, expect, test } from "vitest";
import {
  composeMatrix,
  invertAffine,
  localFromWorld,
  multiplyMatrices,
} from "../../src/scene/transforms.ts";

function expectMatrix(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(Array.from(actual)).toEqual(expected);
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, precision = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) expect(actual[index]).toBeCloseTo(expected[index]!, precision);
}

function caught(run: () => void): { code?: string; fix?: string } {
  try {
    run();
    return {};
  } catch (error) {
    return error as { code?: string; fix?: string };
  }
}

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

describe("scene transforms", () => {
  test("composeMatrix applies the complete default transform", () => {
    const out = new Float32Array(16).fill(7);

    expect(composeMatrix({}, out)).toBe(out);
    expectMatrix(out, IDENTITY);
  });

  test("composeMatrix combines translation, intrinsic rotation, and scalar or vector scale", () => {
    const scalar = composeMatrix({ position: [2, 3, 4], rotation: [0, Math.PI / 2, 0], scale: 2 }, new Float32Array(16));
    expectClose(scalar, [
      0, 0, -2, 0,
      0, 2, 0, 0,
      2, 0, 0, 0,
      2, 3, 4, 1,
    ]);

    const vector = composeMatrix({ rotation: [Math.PI / 2, 0, 0], scale: [2, 3, 4] }, new Float32Array(16));
    expectClose(vector, [
      2, 0, 0, 0,
      0, 0, 3, 0,
      0, -4, 0, 0,
      0, 0, 0, 1,
    ]);

    const mixed = composeMatrix({ rotation: [0.31, -0.47, 0.23] }, new Float32Array(16));
    // Independently derived column-major Rx * Ry * Rz basis for intrinsic XYZ.
    expectClose(mixed, [
      0.8680900811, 0.0825919447, 0.4894876728, 0,
      -0.2032575304, 0.9587518555, 0.1986989075, 0,
      -0.4528862854, -0.2719806063, 0.8490704107, 0,
      0, 0, 0, 1,
    ]);
  });

  test("a supplied quaternion wins over Euler rotation and is normalized without mutating input", () => {
    const quaternion = [0, 2, 0, 2];
    const out = composeMatrix({ rotation: [Number.NaN, 0, 0], quaternion }, new Float32Array(16));

    expect(quaternion).toEqual([0, 2, 0, 2]);
    expectClose(out, [
      0, 0, -1, 0,
      0, 1, 0, 0,
      1, 0, 0, 0,
      0, 0, 0, 1,
    ]);
  });

  test("multiplyMatrices preserves shear and reflection and supports all output aliases", () => {
    const shear = new Float32Array([
      1, 0, 0, 0,
      2, 1, 0, 0,
      0, 0, 1, 0,
      3, 4, 5, 1,
    ]);
    const reflection = new Float32Array([
      -1, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 3, 0,
      1, 2, 3, 1,
    ]);
    const expected = [-1, 0, 0, 0, 4, 2, 0, 0, 0, 0, 3, 0, 8, 6, 8, 1];
    const product = multiplyMatrices(shear, reflection, new Float32Array(16));
    expectMatrix(product, expected);
    expectClose(multiplyMatrices(product, invertAffine(product, new Float32Array(16)), new Float32Array(16)), IDENTITY);

    const leftAlias = new Float32Array(shear);
    multiplyMatrices(leftAlias, reflection, leftAlias);
    expectMatrix(leftAlias, expected);
    const rightAlias = new Float32Array(reflection);
    multiplyMatrices(shear, rightAlias, rightAlias);
    expectMatrix(rightAlias, expected);

    const backing = new Float32Array(36);
    const partialLeft = backing.subarray(0, 16);
    const partialRight = backing.subarray(20, 36);
    const partialOut = backing.subarray(4, 20);
    partialLeft.set(shear);
    partialRight.set(reflection);
    multiplyMatrices(partialLeft, partialRight, partialOut);
    expectMatrix(partialOut, expected);
  });

  test("transform operations reject sizes and invalid numeric values with actionable errors", () => {
    expect(caught(() => composeMatrix({ position: [1, 2] }, new Float32Array(16))).code).toBe("VGPU-SCENE-VALUE");
    expect(caught(() => composeMatrix({}, new Float32Array(15))).code).toBe("VGPU-SPATIAL-SIZE");
    expect(caught(() => multiplyMatrices(new Float32Array(15), IDENTITY, new Float32Array(16))).code).toBe("VGPU-SPATIAL-SIZE");
    expect(caught(() => composeMatrix({ position: [Number.NaN, 0, 0] }, new Float32Array(16))).code).toBe("VGPU-SCENE-VALUE");
    expect(caught(() => composeMatrix({ scale: Number.POSITIVE_INFINITY }, new Float32Array(16))).code).toBe("VGPU-SCENE-VALUE");
    expect(caught(() => composeMatrix({ position: [Number.MAX_VALUE, 0, 0] }, new Float32Array(16))).code).toBe("VGPU-SCENE-VALUE");
    expect(caught(() => composeMatrix({ quaternion: [0, 0, 0, 0] }, new Float32Array(16))).code).toBe("VGPU-SCENE-VALUE");
    expect(caught(() => composeMatrix({ quaternion: [0, 0, 0, 0] }, new Float32Array(16))).fix).toContain("nonzero XYZW quaternion");
  });

  test("invertAffine rejects singular and non-affine inputs without modifying output", () => {
    const output = new Float32Array(16).fill(9);
    const singular = composeMatrix({ scale: [1, 0, 1] }, new Float32Array(16));
    expect(caught(() => invertAffine(singular, output)).code).toBe("VGPU-SPATIAL-SINGULAR");
    expect(Array.from(output)).toEqual(new Array(16).fill(9));

    const nonAffine = new Float32Array(IDENTITY);
    nonAffine[3] = 1;
    expect(caught(() => invertAffine(nonAffine, output)).code).toBe("VGPU-SCENE-VALUE");
    expect(Array.from(output)).toEqual(new Array(16).fill(9));
  });

  test("invertAffine accepts tiny invertible scales when the float32 inverse is representable", () => {
    const matrix = composeMatrix({ position: [2, -3, 4], scale: [1e-20, -2e-20, 4e-20] }, new Float32Array(16));
    const inverse = invertAffine(matrix, matrix);
    const product = multiplyMatrices(
      composeMatrix({ position: [2, -3, 4], scale: [1e-20, -2e-20, 4e-20] }, new Float32Array(16)),
      inverse,
      new Float32Array(16),
    );
    expectClose(product, IDENTITY, 4);
  });

  test("localFromWorld recomposes the child world and stages partially overlapping output", () => {
    const parent = composeMatrix({ position: [3, -2, 1], rotation: [0.2, 0.4, -0.1], scale: [2, 3, -1] }, new Float32Array(16));
    const local = composeMatrix({ position: [-1, 4, 2], rotation: [-0.3, 0.1, 0.2], scale: [0.5, 2, 1] }, new Float32Array(16));
    const world = multiplyMatrices(parent, local, new Float32Array(16));
    const backing = new Float32Array(20);
    const overlappingWorld = backing.subarray(0, 16);
    const output = backing.subarray(4, 20);
    overlappingWorld.set(world);

    localFromWorld(parent, overlappingWorld, output);
    expectClose(output, local, 4);
    expectClose(multiplyMatrices(parent, output, new Float32Array(16)), world, 4);
  });

  test("localFromWorld rejects an unrepresentable parent inverse even when the world would cancel it", () => {
    const parent = composeMatrix({ scale: [1e-40, 1, 1] }, new Float32Array(16));
    const world = new Float32Array(parent);
    const output = new Float32Array(16).fill(4);

    expect(caught(() => localFromWorld(parent, world, output)).code).toBe("VGPU-SPATIAL-SINGULAR");
    expect(Array.from(output)).toEqual(new Array(16).fill(4));
  });

  test("localFromWorld reports final-product overflow as a scene value error", () => {
    const parent = composeMatrix({ scale: [1e-30, 1, 1] }, new Float32Array(16));
    const world = composeMatrix({ scale: [1e30, 1, 1] }, new Float32Array(16));
    const output = new Float32Array(16).fill(5);

    expect(caught(() => localFromWorld(parent, world, output)).code).toBe("VGPU-SCENE-VALUE");
    expect(Array.from(output)).toEqual(new Array(16).fill(5));
  });
});

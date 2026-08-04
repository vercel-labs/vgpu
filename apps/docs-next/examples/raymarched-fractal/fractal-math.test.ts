import { describe, expect, test } from 'vitest';
import { TETRA_VERTICES, baseDistance, containsFiniteFractal, transformToNearestChild } from './fractal-math';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

describe('finite Sierpiński tetrahedron mirror', () => {
  test('declares a regular unit tetrahedron with the intended face planes', () => {
    for (const vertex of TETRA_VERTICES) close(vertex.reduce((s, x) => s + x * x, 0), 1);
    for (let i = 0; i < 4; i++) {
      close(baseDistance(TETRA_VERTICES[i]), 0);
      const faceCenter = TETRA_VERTICES.filter((_, j) => j !== i).reduce<[number, number, number]>(
        (sum, v) => [sum[0] + v[0] / 3, sum[1] + v[1] / 3, sum[2] + v[2] / 3], [0, 0, 0]);
      expect(baseDistance(faceCenter)).toBeLessThanOrEqual(1e-12);
    }
  });

  test('accepts a level-one corner child and rejects the central gap', () => {
    expect(containsFiniteFractal(TETRA_VERTICES[0], 1)).toBe(true);
    expect(containsFiniteFractal([0, 0, 0], 1)).toBe(false);
  });

  test('six nearest-child transforms are finite and use exact scale 64', () => {
    const result = transformToNearestChild([0.21, 0.42, -0.11], 6);
    expect(result.scale).toBe(64);
    expect(result.point.every(Number.isFinite)).toBe(true);
    close(result.distance, baseDistance(result.point) / 64);
  });
});

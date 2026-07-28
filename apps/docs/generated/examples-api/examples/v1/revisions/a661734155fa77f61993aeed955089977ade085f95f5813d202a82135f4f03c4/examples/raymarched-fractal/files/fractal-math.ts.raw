export type Vec3 = readonly [number, number, number];

const SQRT_8_9 = Math.sqrt(8 / 9);
const SQRT_2_9 = Math.sqrt(2 / 9);
const SQRT_2_3 = Math.sqrt(2 / 3);

export const TETRA_VERTICES: readonly Vec3[] = [
  [0, 1, 0],
  [SQRT_8_9, -1 / 3, 0],
  [-SQRT_2_9, -1 / 3, SQRT_2_3],
  [-SQRT_2_9, -1 / 3, -SQRT_2_3],
];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Conservative signed distance bound for the solid unit tetrahedron. */
export function baseDistance(point: Vec3): number {
  return Math.max(...TETRA_VERTICES.map((v) => -dot(v, point) - 1 / 3));
}

/** Mirrors the shader's fixed nearest-corner subdivision transform. */
export function transformToNearestChild(point: Vec3, levels = 6) {
  let p: Vec3 = [...point];
  let scale = 1;
  for (let level = 0; level < levels; level++) {
    let closest = TETRA_VERTICES[0];
    let greatest = dot(p, closest);
    for (let i = 1; i < TETRA_VERTICES.length; i++) {
      const score = dot(p, TETRA_VERTICES[i]);
      if (score > greatest) { greatest = score; closest = TETRA_VERTICES[i]; }
    }
    p = [2 * p[0] - closest[0], 2 * p[1] - closest[1], 2 * p[2] - closest[2]];
    scale *= 2;
  }
  return { point: p, scale, distance: baseDistance(p) / scale } as const;
}

export function containsFiniteFractal(point: Vec3, levels = 6): boolean {
  return transformToNearestChild(point, levels).distance <= 1e-12;
}

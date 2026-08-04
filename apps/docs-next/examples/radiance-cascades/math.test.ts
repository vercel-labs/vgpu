import { describe, expect, it } from 'vitest';

import {
  atlasDecode,
  atlasSizeFor,
  atlasTexel,
  bilinearWeights,
  blockSize,
  bruteForceDistance,
  cascadeCount,
  cascadeCountForSize,
  clampProbe,
  coveredDistance,
  intervalEnd,
  intervalLength,
  intervalStart,
  jfaDistance,
  jfaJumps,
  jfaPick,
  mergeRadiance,
  probeOrigin,
  probeSpacing,
  rayCount,
  rayDirection,
  sampleBilinear,
  segmentDistance,
  sphereTrace,
  strokeRadiance,
  triangleDistance,
  trianglePoints,
  RC_BRANCH_WEIGHT,
  RC_INTERVAL0,
  RC_OVERLAP,
  type TextureView,
  type Vec2,
} from './math';

describe('cascade addressing', () => {
  it('keeps the base-4 relationship between rays, spacing and atlas block', () => {
    for (let cascade = 0; cascade <= 5; cascade++) {
      expect(rayCount(cascade)).toBe(4 ** (cascade + 1));
      expect(probeSpacing(cascade)).toBe(2 ** cascade);
      expect(blockSize(cascade)).toBe(Math.sqrt(rayCount(cascade)));
    }
  });

  it('gives every cascade the same atlas footprint', () => {
    const { scene, atlas } = atlasSizeFor(1280, 720, 6);
    for (let cascade = 0; cascade <= 5; cascade++) {
      const probesX = scene[0] / probeSpacing(cascade);
      const probesY = scene[1] / probeSpacing(cascade);
      expect(probesX * blockSize(cascade)).toBe(atlas[0]);
      expect(probesY * blockSize(cascade)).toBe(atlas[1]);
    }
  });

  it('pads the scene up to a whole number of coarsest probes', () => {
    const { scene, atlas } = atlasSizeFor(1280, 720, 6);
    expect(scene).toEqual([1280, 736]);
    expect(atlas).toEqual([2560, 1472]);
  });

  it('sweeps directions uniformly, starting half a slot in', () => {
    for (const rays of [4, 16, 64, 256]) {
      const first = rayDirection(0, rays);
      const angles = Array.from({ length: rays }, (_, index) => (2 * Math.PI * (index + 0.5)) / rays);
      expect(Math.atan2(first[1], first[0])).toBeCloseTo(angles[0]!, 10);
      const last = rayDirection(rays - 1, rays);
      expect(Math.hypot(last[0], last[1])).toBeCloseTo(1, 10);
      // The four children of a parent ray average exactly back to it.
      const parent = rayDirection(3, rays);
      let sumX = 0;
      let sumY = 0;
      for (let branch = 0; branch < 4; branch++) {
        const child = rayDirection(3 * 4 + branch, rays * 4);
        sumX += child[0] * RC_BRANCH_WEIGHT;
        sumY += child[1] * RC_BRANCH_WEIGHT;
      }
      const mean = Math.atan2(sumY, sumX);
      expect(mean).toBeCloseTo(Math.atan2(parent[1], parent[0]), 6);
    }
  });

  it('round-trips probe and direction through the atlas for R = 4, 16, 64 and 256', () => {
    for (let cascade = 0; cascade <= 3; cascade++) {
      const block = blockSize(cascade);
      const rays = rayCount(cascade);
      for (const probe of [[0, 0], [1, 0], [3, 7], [12, 5]] as Vec2[]) {
        for (const direction of [0, 1, Math.floor(rays / 2), rays - 1]) {
          const texel = atlasTexel(probe, direction, block);
          const decoded = atlasDecode(texel, block);
          expect([decoded[0], decoded[1]]).toEqual([probe[0], probe[1]]);
          expect(decoded[2]).toBe(direction);
        }
      }
    }
  });

  it('places probes at the centre of their footprint', () => {
    expect(probeOrigin([0, 0], 1)).toEqual([0.5, 0.5]);
    expect(probeOrigin([3, 2], 8)).toEqual([28, 20]);
  });

  it('clamps probes inside the grid', () => {
    expect(clampProbe([-1, 9], [8, 8])).toEqual([0, 7]);
  });
});

describe('cascade intervals', () => {
  it('grows the interval by exactly 4 and starts where the previous one ended', () => {
    for (let cascade = 0; cascade <= 5; cascade++) {
      expect(intervalLength(cascade)).toBeCloseTo(RC_INTERVAL0 * 4 ** cascade, 9);
      expect(intervalStart(cascade + 1)).toBeCloseTo(intervalStart(cascade) + intervalLength(cascade), 9);
      expect(intervalLength(cascade + 1) / intervalLength(cascade)).toBeCloseTo(4, 9);
    }
    expect(intervalStart(0)).toBe(0);
  });

  it('overlaps neighbours by 2% instead of leaving a seam', () => {
    for (let cascade = 0; cascade <= 5; cascade++) {
      const end = intervalEnd(cascade, RC_INTERVAL0, RC_OVERLAP);
      const nextStart = intervalStart(cascade + 1);
      expect(end).toBeGreaterThan(nextStart);
      expect(end - nextStart).toBeCloseTo(intervalLength(cascade) * RC_OVERLAP, 9);
    }
  });

  it('covers the diagonal with 5 to 6 cascades', () => {
    expect(cascadeCountForSize(1280, 720)).toBe(6);
    expect(cascadeCountForSize(320, 180)).toBe(5);
    // Whatever the count, the hierarchy reaches past the diagonal it was sized for.
    for (const [width, height] of [[320, 180], [960, 540], [1280, 720], [1600, 900]] as Vec2[]) {
      const count = cascadeCountForSize(width, height);
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(6);
      expect(coveredDistance(count)).toBeGreaterThanOrEqual(Math.hypot(width, height));
    }
  });

  it('clamps oversized screens to six cascades', () => {
    expect(cascadeCount(100_000)).toBe(6);
    expect(cascadeCount(1)).toBe(5);
  });
});

describe('merge', () => {
  it('passes the far interval through only where the near one stayed open', () => {
    const far = [1, 2, 3, 1] as const;
    expect(mergeRadiance([0, 0, 0, 1], far)).toEqual([1, 2, 3, 1]);
    // A hit closes the ray: nothing behind it contributes.
    expect(mergeRadiance([0.4, 0.5, 0.6, 0], far)).toEqual([0.4, 0.5, 0.6, 0]);
    const partial = mergeRadiance([0.2, 0, 0, 0.5], far);
    expect(partial[0]).toBeCloseTo(0.7, 9);
    expect(partial[3]).toBeCloseTo(0.5, 9);
  });

  it('uses bilinear weights that sum to one', () => {
    for (const [fx, fy] of [[0, 0], [1, 1], [0.25, 0.75], [0.5, 0.5]] as Vec2[]) {
      const weights = bilinearWeights(fx, fy);
      expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 9);
    }
    expect(bilinearWeights(0, 0)).toEqual([1, 0, 0, 0]);
    expect(bilinearWeights(1, 1)).toEqual([0, 0, 0, 1]);
    expect(RC_BRANCH_WEIGHT * 4).toBe(1);
  });
});

describe('jump flood', () => {
  it('halves the jump down to one, then adds the two JFA+2 rounds', () => {
    expect(jfaJumps(8)).toEqual([4, 2, 1, 1, 1]);
    expect(jfaJumps(1280)).toEqual([1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 1, 1]);
  });

  it('keeps the nearer valid seed', () => {
    const near = [2.5, 2.5, 0, 1] as const;
    const far = [7.5, 7.5, 0, 1] as const;
    const empty = [0, 0, 0, 0] as const;
    expect(jfaPick(far, near, [3, 3])).toEqual(near);
    expect(jfaPick(near, far, [3, 3])).toEqual(near);
    expect(jfaPick(near, empty, [3, 3])).toEqual(near);
    expect(jfaPick(empty, far, [3, 3])).toEqual(far);
  });

  it('reports the far distance when nothing was found', () => {
    expect(jfaDistance([0, 0, 0, 0], [3, 3], 999)).toBe(999);
    expect(jfaDistance([2.5, 2.5, 0, 1], [2.5, 5.5], 999)).toBeCloseTo(3, 9);
  });

  it('matches a brute-force nearest search on an 8x8 mask', () => {
    const mask = maskTexture(8, 8, [[2, 3], [6, 1]]);
    for (const position of [[0.5, 0.5], [4.5, 4.5], [7.5, 7.5]] as Vec2[]) {
      const expected = Math.min(
        Math.hypot(2.5 - position[0], 3.5 - position[1]),
        Math.hypot(6.5 - position[0], 1.5 - position[1]),
      );
      expect(bruteForceDistance(mask, position, 999)).toBeCloseTo(expected, 9);
    }
  });
});

describe('scene geometry', () => {
  it('measures distance to a segment, including past its ends', () => {
    expect(segmentDistance([5, 0], [0, 0], [10, 0])).toBe(0);
    expect(segmentDistance([5, 3], [0, 0], [10, 0])).toBeCloseTo(3, 9);
    expect(segmentDistance([-4, 0], [0, 0], [10, 0])).toBeCloseTo(4, 9);
  });

  it('signs the triangle distance negative inside', () => {
    const [a, b, c] = trianglePoints([100, 100], 30);
    expect(triangleDistance([50, 50], a, b, c)).toBeLessThan(0);
    expect(triangleDistance([5, 5], a, b, c)).toBeGreaterThan(0);
    // Apex up: uv.y grows downwards, so the apex sits above the centre.
    expect(a[1]).toBeLessThan(50);
    expect(b[1]).toBeGreaterThan(50);
  });

  it('gives every stroke a distinct, bounded colour', () => {
    const first = strokeRadiance(1);
    const second = strokeRadiance(2);
    expect(first).not.toEqual(second);
    for (const channel of [...first, ...second]) {
      expect(channel).toBeGreaterThan(0);
      expect(channel).toBeLessThanOrEqual(2.7);
    }
  });
});

describe('sphere tracing', () => {
  const size: Vec2 = [16, 16];
  // A single emitter texel at (12, 8): distance field and radiance both analytic.
  const emitterPixel: Vec2 = [12.5, 8.5];
  const sdf: TextureView = {
    width: 16,
    height: 16,
    channels: 1,
    data: Array.from({ length: 256 }, (_, index) => {
      const x = (index % 16) + 0.5;
      const y = Math.floor(index / 16) + 0.5;
      return Math.hypot(x - emitterPixel[0], y - emitterPixel[1]);
    }),
  };
  const emitter: TextureView = {
    width: 16,
    height: 16,
    channels: 4,
    data: Array.from({ length: 256 * 4 }, (_, index) => {
      const texel = Math.floor(index / 4);
      const x = (texel % 16) + 0.5;
      const y = Math.floor(texel / 16) + 0.5;
      const inside = Math.hypot(x - emitterPixel[0], y - emitterPixel[1]) < 0.9;
      return inside ? [2, 1, 0.5, 1][index % 4]! : 0;
    }),
  };

  it('hits the emitter along the ray that points at it', () => {
    const hit = sphereTrace(sdf, emitter, size, [2.5, 8.5], [1, 0], 0, 20, 1);
    expect(hit.visibility).toBe(0);
    expect(hit.radiance[0]).toBeGreaterThan(0.5);
    expect(hit.steps).toBeLessThan(16);
    expect(hit.hitDistance).toBeGreaterThan(8);
  });

  it('escapes when the interval stops short of the emitter', () => {
    const miss = sphereTrace(sdf, emitter, size, [2.5, 8.5], [1, 0], 0, 4, 1);
    expect(miss.visibility).toBe(1);
    expect(miss.radiance).toEqual([0, 0, 0]);
  });

  it('escapes when the ray points away', () => {
    const away = sphereTrace(sdf, emitter, size, [2.5, 8.5], [-1, 0], 0, 20, 1);
    expect(away.visibility).toBe(1);
  });

  it('agrees with a dense fixed-step reference on where the hit is', () => {
    const origin: Vec2 = [2.5, 8.5];
    const direction: Vec2 = [1, 0];
    const traced = sphereTrace(sdf, emitter, size, origin, direction, 0, 20, 1);
    let reference = -1;
    for (let step = 0; step < 2048; step++) {
      const t = (step + 0.5) * (20 / 2048);
      const x = origin[0] + direction[0] * t;
      const y = origin[1] + direction[1] * t;
      if (sampleBilinear(sdf, [x / size[0], y / size[1]])[0]! <= 0.5) { reference = t; break; }
    }
    expect(reference).toBeGreaterThan(0);
    // Sphere tracing lands within one epsilon-sized step of the brute-force crossing.
    expect(Math.abs(traced.hitDistance - reference)).toBeLessThan(1);
  });
});

function maskTexture(width: number, height: number, points: readonly Vec2[]): TextureView {
  const data = new Array<number>(width * height).fill(0);
  for (const [x, y] of points) data[y * width + x] = 1;
  return { width, height, channels: 1, data };
}

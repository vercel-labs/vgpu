/**
 * CPU mirror of every WGSL helper in this example.
 *
 * The pipeline is six merged cascades on top of a jump-flooded distance field: nothing
 * about it can be judged by looking at the final image, so each piece has a reference here
 * that `math.test.ts` pins down and that `scripts/radiance-cascades-math-harness.mjs`
 * diffs the shaders against, pixel by pixel, inside the deterministic container.
 */

/** Branching factor: 4x the rays and 4x the distance on every level. */
export const RC_BASE = 4;
/** Length of cascade 0's ray interval, in scene pixels. */
export const RC_INTERVAL0 = 2;
/** Intervals overlap by 2% so neighbouring levels cannot leave a seam. */
export const RC_OVERLAP = 0.02;
/** The research's quality floor and ceiling for a screen-sized 2D cascade hierarchy. */
export const RC_MIN_CASCADES = 5;
export const RC_MAX_CASCADES = 6;
/** Weight of each child direction when four upper rays fold into one lower ray. */
export const RC_BRANCH_WEIGHT = 0.25;

export const SDF_HIT_EPSILON = 0.5;
export const SDF_MIN_STEP = 0.35;
export const SDF_MAX_STEPS = 16;

export type Vec2 = readonly [number, number];
export type Vec4 = readonly [number, number, number, number];

/** Rays per probe: `4^(c+1)`. */
export function rayCount(cascade: number): number {
  return RC_BASE ** (cascade + 1);
}

/** Probe spacing in scene pixels: `2^c`. */
export function probeSpacing(cascade: number): number {
  return 2 ** cascade;
}

/** Side of a probe's direction block in the atlas: `2^(c+1)`. */
export function blockSize(cascade: number): number {
  return 2 ** (cascade + 1);
}

export function rayDirection(index: number, rays: number): Vec2 {
  const theta = (2 * Math.PI * (index + 0.5)) / rays;
  return [Math.cos(theta), Math.sin(theta)];
}

/** Atlas texel -> `[probeX, probeY, directionIndex]`. */
export function atlasDecode(texel: Vec2, block: number): readonly [number, number, number] {
  const probeX = Math.floor(texel[0] / block);
  const probeY = Math.floor(texel[1] / block);
  const slotX = texel[0] - probeX * block;
  const slotY = texel[1] - probeY * block;
  return [probeX, probeY, slotY * block + slotX];
}

/** Probe + direction -> atlas texel. */
export function atlasTexel(probe: Vec2, directionIndex: number, block: number): Vec2 {
  return [probe[0] * block + (directionIndex % block), probe[1] * block + Math.floor(directionIndex / block)];
}

export function probeOrigin(probe: Vec2, spacing: number): Vec2 {
  return [(probe[0] + 0.5) * spacing, (probe[1] + 0.5) * spacing];
}

export function intervalStart(cascade: number, interval0 = RC_INTERVAL0): number {
  return (interval0 * (RC_BASE ** cascade - 1)) / 3;
}

export function intervalLength(cascade: number, interval0 = RC_INTERVAL0): number {
  return interval0 * RC_BASE ** cascade;
}

export function intervalEnd(cascade: number, interval0 = RC_INTERVAL0, overlap = RC_OVERLAP): number {
  return intervalStart(cascade, interval0) + intervalLength(cascade, interval0) * (1 + overlap);
}

/** Distance the whole hierarchy reaches, ignoring the overlap. */
export function coveredDistance(count: number, interval0 = RC_INTERVAL0): number {
  return (interval0 * (RC_BASE ** count - 1)) / 3;
}

/**
 * Levels needed to reach `diagonal` pixels, clamped to 5..6.
 *
 * Solving `interval0 * (4^n - 1) / 3 >= diagonal` exactly — instead of the usual
 * `log4(D / interval0)` approximation — is what keeps the last interval from stopping
 * short of the far corner and leaving an unlit border.
 */
export function cascadeCount(diagonal: number, interval0 = RC_INTERVAL0): number {
  const exact = Math.ceil(Math.log(1 + (3 * diagonal) / interval0) / Math.log(4));
  return Math.min(RC_MAX_CASCADES, Math.max(RC_MIN_CASCADES, exact));
}

export function cascadeCountForSize(width: number, height: number, interval0 = RC_INTERVAL0): number {
  return cascadeCount(Math.hypot(width, height), interval0);
}

/**
 * Atlas dimensions shared by every cascade.
 *
 * The scene is rounded up to a whole number of coarsest probes so that
 * `probes(c) * block(c) = 2 * padded` exactly on every level; without the rounding the
 * per-level `ceil` would give each cascade a slightly different atlas and the two
 * recycled targets could not be shared.
 */
export function atlasSizeFor(width: number, height: number, count: number): { scene: Vec2; atlas: Vec2 } {
  const coarsest = probeSpacing(count - 1);
  const paddedWidth = Math.ceil(Math.max(1, width) / coarsest) * coarsest;
  const paddedHeight = Math.ceil(Math.max(1, height) / coarsest) * coarsest;
  return { scene: [paddedWidth, paddedHeight], atlas: [paddedWidth * 2, paddedHeight * 2] };
}

/** Visibility merge, near over far. */
export function mergeRadiance(near: Vec4, far: Vec4): Vec4 {
  return [
    near[0] + near[3] * far[0],
    near[1] + near[3] * far[1],
    near[2] + near[3] * far[2],
    near[3] * far[3],
  ];
}

/** Bilinear weights, ordered (0,0) (1,0) (0,1) (1,1); they sum to 1. */
export function bilinearWeights(fx: number, fy: number): Vec4 {
  const x = Math.min(1, Math.max(0, fx));
  const y = Math.min(1, Math.max(0, fy));
  return [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
}

export function clampProbe(probe: Vec2, grid: Vec2): Vec2 {
  return [
    Math.min(grid[0] - 1, Math.max(0, probe[0])),
    Math.min(grid[1] - 1, Math.max(0, probe[1])),
  ];
}

/**
 * Jump distances of the flood: `size/2, size/4 ... 1`, then two more rounds at 1 (JFA+2).
 *
 * Plain jump flooding is an approximation, and the harness caught it: on an 8x8 scene the
 * far corner ended up 6.40 px from the wrong emitter instead of 6.08 px from the right one,
 * because the correct seed never reached a texel it could be read from at jump 1. Two extra
 * unit rounds — the standard JFA+2 — let the last neighbourhood settle, and cost two
 * fullscreen passes out of thirteen.
 */
export function jfaJumps(size: number): number[] {
  const passes = Math.ceil(Math.log2(Math.max(size, 2)));
  return [...Array.from({ length: passes }, (_, index) => Math.max(1, 2 ** (passes - index - 1))), 1, 1];
}

export function jfaPick(current: Vec4, candidate: Vec4, position: Vec2): Vec4 {
  if (candidate[3] < 0.5) return current;
  if (current[3] < 0.5) return candidate;
  const currentDistance = Math.hypot(current[0] - position[0], current[1] - position[1]);
  const candidateDistance = Math.hypot(candidate[0] - position[0], candidate[1] - position[1]);
  return candidateDistance < currentDistance ? candidate : current;
}

export function jfaDistance(seed: Vec4, position: Vec2, far: number): number {
  return seed[3] >= 0.5 ? Math.hypot(seed[0] - position[0], seed[1] - position[1]) : far;
}

export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const pax = p[0] - a[0];
  const pay = p[1] - a[1];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / Math.max(bax * bax + bay * bay, 1e-6)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed distance to a triangle; negative inside. */
export function triangleDistance(p: Vec2, p0: Vec2, p1: Vec2, p2: Vec2): number {
  const edges: Vec2[] = [
    [p1[0] - p0[0], p1[1] - p0[1]],
    [p2[0] - p1[0], p2[1] - p1[1]],
    [p0[0] - p2[0], p0[1] - p2[1]],
  ];
  const vectors: Vec2[] = [
    [p[0] - p0[0], p[1] - p0[1]],
    [p[0] - p1[0], p[1] - p1[1]],
    [p[0] - p2[0], p[1] - p2[1]],
  ];
  const sign = Math.sign(edges[0]![0] * edges[2]![1] - edges[0]![1] * edges[2]![0]);
  let squared = Infinity;
  let winding = Infinity;
  for (let i = 0; i < 3; i++) {
    const e = edges[i]!;
    const v = vectors[i]!;
    const h = Math.min(1, Math.max(0, (v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1])));
    const qx = v[0] - e[0] * h;
    const qy = v[1] - e[1] * h;
    const candidate = qx * qx + qy * qy;
    const side = sign * (v[0] * e[1] - v[1] * e[0]);
    if (candidate < squared) squared = candidate;
    if (side < winding) winding = side;
  }
  return -Math.sqrt(squared) * Math.sign(winding);
}

/** The scene triangle in pixel space; uv.y grows downwards, so the apex is at -y. */
export function trianglePoints(size: Vec2, radius: number): readonly [Vec2, Vec2, Vec2] {
  const centre: Vec2 = [size[0] * 0.5, size[1] * 0.5];
  return [
    [centre[0], centre[1] - radius],
    [centre[0] + radius * 0.8660254, centre[1] + radius * 0.5],
    [centre[0] - radius * 0.8660254, centre[1] + radius * 0.5],
  ];
}

export interface TextureView {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: ArrayLike<number>;
}

/** Half-texel-clamped UV, matching `sdf_pixel_uv`. */
export function clampUv(pixel: Vec2, size: Vec2): Vec2 {
  return [
    Math.min(1 - 0.5 / size[0], Math.max(0.5 / size[0], pixel[0] / size[0])),
    Math.min(1 - 0.5 / size[1], Math.max(0.5 / size[1], pixel[1] / size[1])),
  ];
}

/** Bilinear texture fetch with clamp-to-edge, matching `textureSampleLevel(..., 0)`. */
export function sampleBilinear(texture: TextureView, uv: Vec2): number[] {
  const x = uv[0] * texture.width - 0.5;
  const y = uv[1] * texture.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const weights = bilinearWeights(fx, fy);
  const out = new Array<number>(texture.channels).fill(0);
  const corners: Vec2[] = [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
  for (let corner = 0; corner < 4; corner++) {
    const cx = Math.min(texture.width - 1, Math.max(0, corners[corner]![0]));
    const cy = Math.min(texture.height - 1, Math.max(0, corners[corner]![1]));
    const base = (cy * texture.width + cx) * texture.channels;
    for (let channel = 0; channel < texture.channels; channel++) {
      out[channel] += weights[corner]! * texture.data[base + channel]!;
    }
  }
  return out;
}

export interface TraceResult {
  readonly radiance: readonly [number, number, number];
  /** 1 when the ray escaped the interval, 0 when it hit an emitter. */
  readonly visibility: number;
  readonly steps: number;
  readonly hitDistance: number;
}

/**
 * CPU sphere tracer: the exact loop `sphere_trace` runs, against the same sampled data.
 *
 * `sdf` and `emitter` are read back from the GPU before this runs, so the comparison
 * isolates the marching logic from any difference in how the two sides store the field.
 */
export function sphereTrace(
  sdf: TextureView,
  emitter: TextureView,
  size: Vec2,
  origin: Vec2,
  direction: Vec2,
  tStart: number,
  tEnd: number,
  sdfScale: number,
): TraceResult {
  let t = tStart;
  for (let step = 0; step < SDF_MAX_STEPS; step++) {
    const p: Vec2 = [origin[0] + direction[0] * t, origin[1] + direction[1] * t];
    if (p[0] < -1 || p[1] < -1 || p[0] > size[0] + 1 || p[1] > size[1] + 1) {
      return { radiance: [0, 0, 0], visibility: 1, steps: step, hitDistance: -1 };
    }
    const uv = clampUv(p, size);
    const d = sampleBilinear(sdf, uv)[0]! * sdfScale;
    if (d <= SDF_HIT_EPSILON) {
      const sample = sampleBilinear(emitter, uv);
      return { radiance: [sample[0]!, sample[1]!, sample[2]!], visibility: 0, steps: step, hitDistance: t };
    }
    t += Math.max(d, SDF_MIN_STEP);
    if (t > tEnd) break;
  }
  return { radiance: [0, 0, 0], visibility: 1, steps: SDF_MAX_STEPS, hitDistance: -1 };
}

/** Brute-force nearest-emitter distance; the oracle the jump flood must reproduce. */
export function bruteForceDistance(mask: TextureView, position: Vec2, far: number, threshold = 0.5): number {
  let best = far;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const value = mask.data[(y * mask.width + x) * mask.channels + (mask.channels - 1)]!;
      if (value <= threshold) continue;
      best = Math.min(best, Math.hypot(x + 0.5 - position[0], y + 0.5 - position[1]));
    }
  }
  return best;
}

/**
 * Linear radiance of stroke `index`.
 *
 * Deterministic: the palette walks the hue circle by the golden angle, so consecutive
 * strokes are easy to tell apart and a scripted stroke always paints the same colour.
 */
export function strokeRadiance(index: number, intensity = 2.7): readonly [number, number, number] {
  const hue = (index * 0.381966) % 1;
  const channel = (offset: number): number => {
    const t = Math.abs(((hue + offset) % 1) * 6 - 3) - 1;
    const clamped = Math.min(1, Math.max(0, t));
    // Never fully desaturate a channel: a pure primary emitter lights the grid in one hue
    // only, which reads as a bug rather than as coloured light.
    return (0.25 + 0.75 * clamped) * intensity;
  };
  return [channel(0), channel(2 / 3), channel(1 / 3)];
}

/** ACES filmic curve; the CPU twin of `tonemap_aces`. */
export function tonemapAces(value: number): number {
  const mapped = (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14);
  return Math.min(1, Math.max(0, mapped));
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055;
}

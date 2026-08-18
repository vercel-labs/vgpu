/**
 * CPU reference for everything `optics.wgsl` does.
 *
 * This file is not used by the browser example — the GPU traces the scene. It
 * exists so the shader has an oracle: `optics.test.ts` asserts the physics here
 * (Snell, total internal reflection, dispersion, uniform triangle sampling),
 * and the Node GPU test renders `probe.wgsl` into an `rgba32float` target and
 * diffs the shader's numbers against these, following
 * `vgpu docs cat shader-debugging.md`.
 *
 * Keep the two implementations line-comparable. Every function below has a
 * same-named counterpart in `optics.wgsl`.
 */

import {
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_RAYS_PER_FRAGMENT,
  PRISM_WAVELENGTHS,
  type DispersionPreset,
  type SpotLight,
  type Triangle,
  type Vec2,
} from './types';

export type Vec3 = readonly [number, number, number];

/** Keeps a ray from immediately re-hitting the surface it just left. */
export const SURFACE_EPSILON = 1e-4;

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const length = (a: Vec2): number => Math.hypot(a[0], a[1]);
const normalize = (a: Vec2): Vec2 => scale(a, 1 / length(a));
/** z of the 3D cross product of two planar vectors: positive when b is left of a. */
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];

const saturate = (value: number): number => Math.min(1, Math.max(0, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = saturate((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed area doubled; positive for counter-clockwise winding. */
export function triangleWinding(triangle: Triangle): number {
  return cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a));
}

/**
 * A uniformly distributed point inside the triangle from two unit randoms.
 *
 * Barycentric coordinates taken straight from two uniforms cover the wrong half
 * of the parallelogram; folding `u + v > 1` back across the diagonal fixes the
 * density without rejecting samples.
 */
export function sampleTriangle(triangle: Triangle, u: number, v: number): Vec2 {
  let bu = u;
  let bv = v;
  if (bu + bv > 1) {
    bu = 1 - bu;
    bv = 1 - bv;
  }
  const edge1 = sub(triangle.b, triangle.a);
  const edge2 = sub(triangle.c, triangle.a);
  return add(triangle.a, add(scale(edge1, bu), scale(edge2, bv)));
}

/** True when the point is on the inner side of all three edges. */
export function insideTriangle(triangle: Triangle, point: Vec2): boolean {
  const sign = triangleWinding(triangle) >= 0 ? 1 : -1;
  const ab = cross(sub(triangle.b, triangle.a), sub(point, triangle.a)) * sign;
  const bc = cross(sub(triangle.c, triangle.b), sub(point, triangle.b)) * sign;
  const ca = cross(sub(triangle.a, triangle.c), sub(point, triangle.c)) * sign;
  return ab >= 0 && bc >= 0 && ca >= 0;
}

/** Cauchy's empirical dispersion law, with the wavelength given in nanometres. */
export function iorAt(wavelengthNm: number, base: number, strength: number): number {
  const micrometres = wavelengthNm * 1e-3;
  return base + strength / (micrometres * micrometres);
}

/**
 * The wavelength ray `index` traces, stratified over the visible range.
 *
 * One wavelength per ray, one stratum per ray: 16 rays cover the spectrum
 * evenly every frame, and `jitter` moves each sample inside its stratum so
 * accumulation converges to the continuous spectrum instead of 16 lines.
 */
export function stratifiedWavelength(
  index: number,
  count: number,
  jitter: number,
  minNm: number = PRISM_WAVELENGTHS.min,
  maxNm: number = PRISM_WAVELENGTHS.max,
): number {
  const t = (index + jitter) / count;
  return minNm + (maxNm - minNm) * t;
}

export interface EdgeHit {
  /** Distance along the ray. */
  readonly t: number;
  /** Unit normal pointing out of the triangle. */
  readonly normal: Vec2;
}

/**
 * Nearest crossing of the triangle's boundary strictly beyond `minT`.
 *
 * Works from inside and outside: the caller decides what a hit means by looking
 * at the sign of `dot(direction, normal)`.
 */
export function intersectTriangle(
  triangle: Triangle,
  origin: Vec2,
  direction: Vec2,
  minT: number,
): EdgeHit | undefined {
  const vertices: readonly [Vec2, Vec2, Vec2] = [triangle.a, triangle.b, triangle.c];
  let best: EdgeHit | undefined;
  for (let index = 0; index < 3; index++) {
    const edgeStart = vertices[index]!;
    const edgeEnd = vertices[(index + 1) % 3]!;
    const edge = sub(edgeEnd, edgeStart);
    const denominator = cross(direction, edge);
    if (denominator === 0) continue;
    const offset = sub(edgeStart, origin);
    const t = cross(offset, edge) / denominator;
    const s = cross(offset, direction) / denominator;
    if (t <= minT || s < 0 || s > 1) continue;
    if (best && best.t <= t) continue;
    // Counter-clockwise winding puts the interior left of every edge, so
    // rotating the edge clockwise points out of the triangle.
    best = { t, normal: normalize([edge[1], -edge[0]]) };
  }
  return best;
}

/**
 * Snell's law in the plane. `normal` faces the side the ray comes from and
 * `eta` is the ratio of indices, incident over transmitted.
 *
 * Returns `undefined` on total internal reflection, which is a real outcome
 * here rather than an error: a ray that enters the prism too straight-on hits
 * the second face past the critical angle and bounces instead of leaving.
 */
export function refract(incident: Vec2, normal: Vec2, eta: number): Vec2 | undefined {
  const cosIncident = -dot(incident, normal);
  const sinTransmittedSquared = eta * eta * (1 - cosIncident * cosIncident);
  if (sinTransmittedSquared > 1) return undefined;
  const cosTransmitted = Math.sqrt(1 - sinTransmittedSquared);
  return add(scale(incident, eta), scale(normal, eta * cosIncident - cosTransmitted));
}

export function reflect(incident: Vec2, normal: Vec2): Vec2 {
  return sub(incident, scale(normal, 2 * dot(incident, normal)));
}

export interface PrismPath {
  /** Where the ray left the glass. */
  readonly origin: Vec2;
  /** Unit direction it left with. */
  readonly direction: Vec2;
  /** Internal reflections taken before it got out. */
  readonly bounces: number;
}

/**
 * Refract a ray through the prism and return the ray that comes out the far side.
 *
 * `origin` is outside the glass and `direction` points into it. The ray
 * refracts on entry, crosses the interior, and refracts again on exit; when the
 * exit face reflects it instead (total internal reflection) it keeps bouncing
 * inside until it escapes or runs out of bounces.
 */
export function tracePrism(
  triangle: Triangle,
  origin: Vec2,
  direction: Vec2,
  ior: number,
  maxBounces = PRISM_MAX_INTERNAL_BOUNCES,
): PrismPath | undefined {
  const entry = intersectTriangle(triangle, origin, direction, SURFACE_EPSILON);
  // A ray that first meets the boundary from behind started inside the glass.
  if (!entry || dot(direction, entry.normal) >= 0) return undefined;

  let position = add(origin, scale(direction, entry.t));
  let inside = refract(direction, entry.normal, 1 / ior);
  if (!inside) return undefined;

  for (let bounces = 0; bounces <= maxBounces; bounces++) {
    const exit = intersectTriangle(triangle, position, inside, SURFACE_EPSILON);
    if (!exit) return undefined;
    position = add(position, scale(inside, exit.t));
    const transmitted = refract(inside, scale(exit.normal, -1), ior);
    if (transmitted) return { origin: position, direction: normalize(transmitted), bounces };
    inside = reflect(inside, exit.normal);
  }
  return undefined;
}

/** Smooth angular falloff for a ray arriving at the lamp from `towardsScene`. */
export function spotProfile(light: SpotLight, towardsScene: Vec2): number {
  const angle = Math.acos(saturate(dot(light.direction, towardsScene)));
  return 1 - smoothstep(light.innerAngle, light.outerAngle, angle);
}

/**
 * How strongly a ray leaving the prism lands on the lamp.
 *
 * The emitter is a disc, so instead of a binary hit test this measures how
 * close the ray passes to its center and falls off smoothly across the radius.
 * That is the same estimator a hard hit test converges to, minus most of the
 * variance — a soft kernel turns a rare binary event into a value almost every
 * sample can contribute to.
 */
export function lightConnection(light: SpotLight, origin: Vec2, direction: Vec2): number {
  const towardsLight = sub(light.center, origin);
  const along = dot(towardsLight, direction);
  if (along <= 0) return 0;
  const closest = length(sub(towardsLight, scale(direction, along)));
  const kernel = 1 - smoothstep(0, light.radius, closest);
  if (kernel <= 0) return 0;
  return kernel * spotProfile(light, scale(direction, -1));
}

/**
 * Analytic approximations of the CIE 1931 color matching functions.
 * Wyman, Sloan and Shirley, JCGT 2013.
 */
function cieX(wavelengthNm: number): number {
  const t1 = (wavelengthNm - 442.0) * (wavelengthNm < 442.0 ? 0.0624 : 0.0374);
  const t2 = (wavelengthNm - 599.8) * (wavelengthNm < 599.8 ? 0.0264 : 0.0323);
  const t3 = (wavelengthNm - 501.1) * (wavelengthNm < 501.1 ? 0.0490 : 0.0382);
  return 0.362 * Math.exp(-0.5 * t1 * t1) + 1.056 * Math.exp(-0.5 * t2 * t2) - 0.065 * Math.exp(-0.5 * t3 * t3);
}

function cieY(wavelengthNm: number): number {
  const t1 = (wavelengthNm - 568.8) * (wavelengthNm < 568.8 ? 0.0213 : 0.0247);
  const t2 = (wavelengthNm - 530.9) * (wavelengthNm < 530.9 ? 0.0613 : 0.0322);
  return 0.821 * Math.exp(-0.5 * t1 * t1) + 0.286 * Math.exp(-0.5 * t2 * t2);
}

function cieZ(wavelengthNm: number): number {
  const t1 = (wavelengthNm - 437.0) * (wavelengthNm < 437.0 ? 0.0845 : 0.0278);
  const t2 = (wavelengthNm - 459.0) * (wavelengthNm < 459.0 ? 0.0385 : 0.0725);
  return 1.217 * Math.exp(-0.5 * t1 * t1) + 0.681 * Math.exp(-0.5 * t2 * t2);
}

/**
 * Linear sRGB for a single wavelength.
 *
 * Spectral colors sit outside the sRGB gamut, so the matrix product goes
 * negative in one channel for most of the spectrum; clamping is the standard
 * approximation and keeps hue ordering intact.
 */
export function wavelengthToLinearRgb(wavelengthNm: number): Vec3 {
  const x = cieX(wavelengthNm);
  const y = cieY(wavelengthNm);
  const z = cieZ(wavelengthNm);
  return [
    Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z),
    Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z),
    Math.max(0, 0.0557 * x - 0.2040 * y + 1.0570 * z),
  ];
}

/** Deterministic integer hash, mirroring `pcg3d` from `@vgpu/wgsl-std/hash`. */
export function pcg3d(x: number, y: number, z: number): readonly [number, number, number] {
  let hx = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  let hy = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  let hz = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  hx = (hx + Math.imul(hy, hz)) >>> 0;
  hy = (hy + Math.imul(hz, hx)) >>> 0;
  hz = (hz + Math.imul(hx, hy)) >>> 0;
  hx ^= hx >>> 16;
  hy ^= hy >>> 16;
  hz ^= hz >>> 16;
  hx = (hx + Math.imul(hy, hz)) >>> 0;
  hy = (hy + Math.imul(hz, hx)) >>> 0;
  hz = (hz + Math.imul(hx, hy)) >>> 0;
  return [hx >>> 0, hy >>> 0, hz >>> 0];
}

/** Mirrors `unitFloat` from `@vgpu/wgsl-std/hash`: 24 bits of mantissa, in [0, 1). */
export function unitFloat(hash: number): number {
  return (hash >>> 8) * (1 / 16777216);
}

export interface TraceParams {
  readonly triangle: Triangle;
  readonly light: SpotLight;
  readonly ior: DispersionPreset;
  readonly exposure: number;
  readonly raysPerFragment?: number;
  readonly maxBounces?: number;
  readonly wavelengths?: { readonly min: number; readonly max: number };
}

/**
 * One ray of the estimator: aim at `aim` on the prism's face, refract through,
 * and weigh whatever comes out the other side by how well it lands on the lamp.
 *
 * The 1/r term keeps a two-dimensional beam's energy constant as it spreads, so
 * the fan dims with distance from the glass the way the real one does.
 */
export function traceRayWeight(
  triangle: Triangle,
  light: SpotLight,
  point: Vec2,
  aim: Vec2,
  ior: number,
  maxBounces = PRISM_MAX_INTERNAL_BOUNCES,
): number {
  const toAim = sub(aim, point);
  const distance = length(toAim);
  if (distance <= SURFACE_EPSILON) return 0;
  const path = tracePrism(triangle, point, scale(toAim, 1 / distance), ior, maxBounces);
  if (!path) return 0;
  return lightConnection(light, path.origin, path.direction) / (0.35 + distance);
}

export interface PrismRay {
  /** Point sampled on the prism's face. */
  readonly aim: Vec2;
  readonly wavelength: number;
  readonly ior: number;
}

/**
 * The `index`-th of a pixel's rays for a frame, mirroring `sceneRay`.
 *
 * Seeding on the pixel *and* the frame is what makes the noise temporal: the
 * same fragment aims somewhere new every frame, which is the whole reason
 * accumulating frames converges.
 */
export function sceneRay(params: TraceParams, pixel: Vec2, frameIndex: number, index: number): PrismRay {
  const count = params.raysPerFragment ?? PRISM_RAYS_PER_FRAGMENT;
  const range = params.wavelengths ?? PRISM_WAVELENGTHS;
  const seed = pcg3d(pixel[0], pixel[1], frameIndex * count + index);
  const wavelength = stratifiedWavelength(index, count, unitFloat(seed[2]), range.min, range.max);
  return {
    aim: sampleTriangle(params.triangle, unitFloat(seed[0]), unitFloat(seed[1])),
    wavelength,
    ior: iorAt(wavelength, params.ior.base, params.ior.strength),
  };
}

/**
 * Radiance arriving at one point of the room from one frame's rays, mirroring
 * `estimateRadiance`.
 */
export function estimateRadiance(
  params: TraceParams,
  point: Vec2,
  pixel: Vec2,
  frameIndex: number,
): Vec3 {
  const count = params.raysPerFragment ?? PRISM_RAYS_PER_FRAGMENT;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let index = 0; index < count; index++) {
    const ray = sceneRay(params, pixel, frameIndex, index);
    const weight = traceRayWeight(
      params.triangle,
      params.light,
      point,
      ray.aim,
      ray.ior,
      params.maxBounces ?? PRISM_MAX_INTERNAL_BOUNCES,
    );
    if (weight <= 0) continue;
    const color = wavelengthToLinearRgb(ray.wavelength);
    r += color[0] * weight;
    g += color[1] * weight;
    b += color[2] * weight;
  }
  const gain = params.exposure / count;
  return [r * gain, g * gain, b * gain];
}

/** Wall points the probe measures, mirroring `probePoint` in `probe.wgsl`. */
export const PROBE_COLUMNS = 8;
export const PROBE_ROWS: readonly number[] = [0.28, -0.04, -0.36, -0.78];

export function probePoint(slot: number): Vec2 {
  return [-1.4 + 0.4 * (slot % PROBE_COLUMNS), PROBE_ROWS[Math.floor(slot / PROBE_COLUMNS)] ?? 0];
}

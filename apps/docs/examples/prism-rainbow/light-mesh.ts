/**
 * Deterministic geometry for the light itself.
 *
 * A finite collimated beam is bounded by two parallel rays. We trace those two
 * boundaries through the same prism for every wavelength, then connect matching
 * path segments into quads. The resulting ribbons cannot collapse to a point
 * unless the physical ray mapping actually focuses them.
 */

import {
  iorAt,
  tracePrismDetailed,
  type DetailedPrismPath,
} from "./optics";
import {
  PRISM_LIGHT_EXPOSURE,
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_SPECTRAL_SAMPLES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  type DispersionPreset,
  type CollimatedLight,
  type Triangle,
  type Vec2,
} from "./types";

/** position.xy, wavelength, transverse profile coordinate, intensity. */
export const LIGHT_VERTEX_FLOATS = 5;
export const LIGHT_VERTEX_STRIDE = LIGHT_VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 6;
const MAX_INTERNAL_SEGMENTS = PRISM_MAX_INTERNAL_BOUNCES + 1;

/** One white incoming quad, then fixed-size internal and outgoing slots per band. */
export function lightVertexCount(samples = PRISM_SPECTRAL_SAMPLES): number {
  return VERTICES_PER_QUAD + samples * (MAX_INTERNAL_SEGMENTS + 1) * VERTICES_PER_QUAD;
}

export interface SpectralBand {
  readonly wavelength: number;
  readonly lower: DetailedPrismPath;
  readonly upper: DetailedPrismPath;
  /** Width measured perpendicular to the outgoing direction. */
  readonly outputWidth: number;
  readonly transmission: number;
}

export interface LightMeshStats {
  readonly samples: number;
  readonly validBands: number;
  readonly rejectedTopology: number;
  readonly minOutputWidth: number;
  readonly maxOutputWidth: number;
  /** Integrated scalar flux, useful for checking subdivision invariance. */
  readonly totalFlux: number;
}

export interface LightMeshData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly vertexCount: number;
  readonly stats: LightMeshStats;
}

export interface LightMeshOptions {
  readonly light: CollimatedLight;
  readonly dispersion: DispersionPreset;
  readonly wallHalfExtent: Vec2;
  readonly triangle?: Triangle;
  readonly samples?: number;
  readonly exposure?: number;
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, amount: number): Vec2 => [a[0] * amount, a[1] * amount];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const normalize = (a: Vec2): Vec2 => {
  const magnitude = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / magnitude, a[1] / magnitude];
};

/** Origins of the lower and upper parallel boundaries of a collimated beam. */
export function beamBoundaryOrigins(light: CollimatedLight): readonly [Vec2, Vec2] {
  const perpendicular: Vec2 = [-light.direction[1], light.direction[0]];
  return [
    add(light.center, scale(perpendicular, -light.beamHalfWidth)),
    add(light.center, scale(perpendicular, light.beamHalfWidth)),
  ];
}

/** First point where a forward ray reaches the axis-aligned wall rectangle. */
export function rayToWallBoundary(origin: Vec2, direction: Vec2, halfExtent: Vec2): Vec2 {
  let nearest = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 2; axis++) {
    const component = direction[axis]!;
    if (Math.abs(component) < 1e-8) continue;
    for (const side of [-halfExtent[axis]!, halfExtent[axis]!] as const) {
      const distance = (side - origin[axis]!) / component;
      if (distance <= 0 || distance >= nearest) continue;
      const other = 1 - axis;
      const otherCoordinate = origin[other]! + direction[other]! * distance;
      if (Math.abs(otherCoordinate) <= halfExtent[other]! + 1e-6) nearest = distance;
    }
  }
  return Number.isFinite(nearest) ? add(origin, scale(direction, nearest)) : origin;
}

function matchingTopology(lower: DetailedPrismPath, upper: DetailedPrismPath): boolean {
  return lower.edges.length === upper.edges.length
    && lower.edges.every((edge, index) => edge === upper.edges[index]);
}

/** Trace the two physical boundaries for one wavelength. */
export function traceSpectralBand(
  triangle: Triangle,
  light: CollimatedLight,
  dispersion: DispersionPreset,
  wavelength: number,
): SpectralBand | undefined {
  const ior = iorAt(wavelength, dispersion.base, dispersion.strength);
  const [lowerOrigin, upperOrigin] = beamBoundaryOrigins(light);
  const lower = tracePrismDetailed(triangle, lowerOrigin, light.direction, ior);
  const upper = tracePrismDetailed(triangle, upperOrigin, light.direction, ior);
  if (!lower || !upper || !matchingTopology(lower, upper)) return undefined;

  const direction = normalize(add(lower.direction, upper.direction));
  const outputWidth = Math.abs(cross(sub(upper.origin, lower.origin), direction));
  if (outputWidth <= 1e-5) return undefined;
  return {
    wavelength,
    lower,
    upper,
    outputWidth,
    transmission: (lower.transmission + upper.transmission) * 0.5,
  };
}

function pushVertex(
  output: number[],
  point: Vec2,
  wavelength: number,
  profile: number,
  intensity: number,
): void {
  output.push(point[0], point[1], wavelength, profile, intensity);
}

function pushQuad(
  output: number[],
  lowerStart: Vec2,
  upperStart: Vec2,
  lowerEnd: Vec2,
  upperEnd: Vec2,
  wavelength: number,
  intensity: number,
): void {
  pushVertex(output, lowerStart, wavelength, -1, intensity);
  pushVertex(output, upperStart, wavelength, 1, intensity);
  pushVertex(output, upperEnd, wavelength, 1, intensity);
  pushVertex(output, lowerStart, wavelength, -1, intensity);
  pushVertex(output, upperEnd, wavelength, 1, intensity);
  pushVertex(output, lowerEnd, wavelength, -1, intensity);
}

function pushEmptyQuad(output: number[]): void {
  pushQuad(output, [0, 0], [0, 0], [0, 0], [0, 0], -1, 0);
}

/** Build all incoming, internal and outgoing ribbons at a fixed vertex count. */
export function buildLightMesh(options: LightMeshOptions): LightMeshData {
  const triangle = options.triangle ?? PRISM_TRIANGLE;
  const samples = Math.max(2, Math.floor(options.samples ?? PRISM_SPECTRAL_SAMPLES));
  const exposure = options.exposure ?? PRISM_LIGHT_EXPOSURE;
  const vertices: number[] = [];
  const inputWidth = options.light.beamHalfWidth * 2;
  let validBands = 0;
  let rejectedTopology = 0;
  let minOutputWidth = Number.POSITIVE_INFINITY;
  let maxOutputWidth = 0;
  let totalFlux = 0;

  // Entry geometry is wavelength-independent. Use the middle of the spectrum to
  // obtain the two exact face intersections, then extend backwards to the frame.
  const middle = traceSpectralBand(
    triangle,
    options.light,
    options.dispersion,
    (PRISM_WAVELENGTHS.min + PRISM_WAVELENGTHS.max) * 0.5,
  );
  if (middle) {
    const lowerEntry = middle.lower.points[0]!;
    const upperEntry = middle.upper.points[0]!;
    const backwards: Vec2 = [-options.light.direction[0], -options.light.direction[1]];
    pushQuad(
      vertices,
      rayToWallBoundary(lowerEntry, backwards, options.wallHalfExtent),
      rayToWallBoundary(upperEntry, backwards, options.wallHalfExtent),
      lowerEntry,
      upperEntry,
      -1,
      0.34,
    );
  } else {
    pushEmptyQuad(vertices);
  }

  for (let index = 0; index < samples; index++) {
    const wavelength = PRISM_WAVELENGTHS.min
      + (PRISM_WAVELENGTHS.max - PRISM_WAVELENGTHS.min) * ((index + 0.5) / samples);
    const band = traceSpectralBand(triangle, options.light, options.dispersion, wavelength);
    if (!band) {
      rejectedTopology++;
      for (let slot = 0; slot < MAX_INTERNAL_SEGMENTS + 1; slot++) pushEmptyQuad(vertices);
      continue;
    }

    validBands++;
    minOutputWidth = Math.min(minOutputWidth, band.outputWidth);
    maxOutputWidth = Math.max(maxOutputWidth, band.outputWidth);
    const density = exposure * band.transmission * (inputWidth / band.outputWidth) / samples;
    totalFlux += density * band.outputWidth;

    for (let segment = 0; segment < MAX_INTERNAL_SEGMENTS; segment++) {
      const lowerStart = band.lower.points[segment];
      const lowerEnd = band.lower.points[segment + 1];
      const upperStart = band.upper.points[segment];
      const upperEnd = band.upper.points[segment + 1];
      if (lowerStart && lowerEnd && upperStart && upperEnd) {
        pushQuad(vertices, lowerStart, upperStart, lowerEnd, upperEnd, wavelength, density * 0.72);
      } else {
        pushEmptyQuad(vertices);
      }
    }

    pushQuad(
      vertices,
      band.lower.origin,
      band.upper.origin,
      rayToWallBoundary(band.lower.origin, band.lower.direction, options.wallHalfExtent),
      rayToWallBoundary(band.upper.origin, band.upper.direction, options.wallHalfExtent),
      wavelength,
      density,
    );
  }

  const data = new Float32Array(vertices);
  const vertexCount = data.length / LIGHT_VERTEX_FLOATS;
  if (vertexCount !== lightVertexCount(samples)) {
    throw new Error(`Light mesh wrote ${vertexCount} vertices; expected ${lightVertexCount(samples)}.`);
  }
  return {
    vertices: data,
    vertexCount,
    stats: {
      samples,
      validBands,
      rejectedTopology,
      minOutputWidth: Number.isFinite(minOutputWidth) ? minOutputWidth : 0,
      maxOutputWidth,
      totalFlux,
    },
  };
}

/**
 * Deterministic geometry for the light itself.
 *
 * The mesh integrates two continuous dimensions. Wavelength vertices are
 * connected to their neighbours, so RGB can interpolate without visible bands.
 * Several additive spectral sheets sample the finite width of the collimated
 * beam, preserving the footprint that a single centre ray would collapse. Their
 * XY coordinates are lifted to a shared world-space depth by `light.wgsl`.
 */

import { iorAt, tracePrismDetailed, type DetailedPrismPath } from "./optics";
import {
  DEFAULT_LIGHT_FADE_CONTROLS,
  PRISM_BEAM_SLICES,
  PRISM_LIGHT_EXPOSURE,
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_SPECTRAL_SAMPLES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  type CollimatedLight,
  type DispersionPreset,
  type Triangle,
  type Vec2,
} from "./types";

/** position.xy, wavelength, transverse profile, intensity, distance from glass. */
export const LIGHT_VERTEX_FLOATS = 6;
export const LIGHT_VERTEX_STRIDE =
  LIGHT_VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VERTICES_PER_QUAD = 6;
const MAX_INTERNAL_SEGMENTS = PRISM_MAX_INTERNAL_BOUNCES + 1;
export const LIGHT_WHITE_QUADS = 1 + MAX_INTERNAL_SEGMENTS;
const DENSITY_MEASURE_DISTANCE = 1;
/** The collimated source is deliberately emissive HDR, not painted white. */
export const INPUT_BEAM_RADIANCE = 6;
/** Fresnel transmission makes the light inside the glass slightly dimmer. */
export const INTERNAL_BEAM_RADIANCE = 4.5;
/** White input/internal quads, then one cell per wavelength interval and beam slice. */
export function lightVertexCount(
  samples = PRISM_SPECTRAL_SAMPLES,
  beamSlices = PRISM_BEAM_SLICES
): number {
  const intervals = Math.max(1, samples - 1);
  return (LIGHT_WHITE_QUADS + intervals * beamSlices) * VERTICES_PER_QUAD;
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
  readonly beamSlices: number;
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
  readonly beamSlices?: number;
  readonly exposure?: number;
  readonly edgeFalloff?: number;
}

interface SpectralNode {
  readonly wavelength: number;
  readonly band: SpectralBand;
  readonly paths: readonly DetailedPrismPath[];
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, amount: number): Vec2 => [a[0] * amount, a[1] * amount];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const normalize = (a: Vec2): Vec2 => {
  const magnitude = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / magnitude, a[1] / magnitude];
};

/** Origin at a normalized coordinate across the finite collimated beam. */
export function beamProfileOrigin(
  light: CollimatedLight,
  profile: number
): Vec2 {
  const perpendicular: Vec2 = [-light.direction[1], light.direction[0]];
  return add(
    light.center,
    scale(
      perpendicular,
      light.beamHalfWidth * Math.min(1, Math.max(-1, profile))
    )
  );
}

/** Origins of the lower and upper parallel boundaries of a collimated beam. */
export function beamBoundaryOrigins(
  light: CollimatedLight
): readonly [Vec2, Vec2] {
  return [beamProfileOrigin(light, -1), beamProfileOrigin(light, 1)];
}

/** First point where a forward ray reaches the axis-aligned wall rectangle. */
export function rayToWallBoundary(
  origin: Vec2,
  direction: Vec2,
  halfExtent: Vec2
): Vec2 {
  let nearest = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 2; axis++) {
    const component = direction[axis]!;
    if (Math.abs(component) < 1e-8) continue;
    for (const side of [-halfExtent[axis]!, halfExtent[axis]!] as const) {
      const distance = (side - origin[axis]!) / component;
      if (distance <= 0 || distance >= nearest) continue;
      const other = 1 - axis;
      const otherCoordinate = origin[other]! + direction[other]! * distance;
      if (Math.abs(otherCoordinate) <= halfExtent[other]! + 1e-6)
        nearest = distance;
    }
  }
  return Number.isFinite(nearest)
    ? add(origin, scale(direction, nearest))
    : origin;
}

function matchingTopology(a: DetailedPrismPath, b: DetailedPrismPath): boolean {
  return (
    a.edges.length === b.edges.length &&
    a.edges.every((edge, index) => edge === b.edges[index])
  );
}

/** Trace the two physical boundaries for one wavelength. */
export function traceSpectralBand(
  triangle: Triangle,
  light: CollimatedLight,
  dispersion: DispersionPreset,
  wavelength: number
): SpectralBand | undefined {
  const ior = iorAt(wavelength, dispersion.base, dispersion.strength);
  const [lowerOrigin, upperOrigin] = beamBoundaryOrigins(light);
  const lower = tracePrismDetailed(triangle, lowerOrigin, light.direction, ior);
  const upper = tracePrismDetailed(triangle, upperOrigin, light.direction, ior);
  if (!lower || !upper || !matchingTopology(lower, upper)) return undefined;

  const direction = normalize(add(lower.direction, upper.direction));
  const outputWidth = Math.abs(
    cross(sub(upper.origin, lower.origin), direction)
  );
  if (outputWidth <= 1e-5) return undefined;
  return {
    wavelength,
    lower,
    upper,
    outputWidth,
    transmission: (lower.transmission + upper.transmission) * 0.5,
  };
}

function traceProfilePath(
  triangle: Triangle,
  light: CollimatedLight,
  dispersion: DispersionPreset,
  wavelength: number,
  profile: number
): DetailedPrismPath | undefined {
  return tracePrismDetailed(
    triangle,
    beamProfileOrigin(light, profile),
    light.direction,
    iorAt(wavelength, dispersion.base, dispersion.strength)
  );
}

function pushVertex(
  output: number[],
  point: Vec2,
  wavelength: number,
  profile: number,
  intensity: number,
  travel: number
): void {
  output.push(point[0], point[1], wavelength, profile, intensity, travel);
}

function pushQuad(
  output: number[],
  lowerStart: Vec2,
  upperStart: Vec2,
  lowerEnd: Vec2,
  upperEnd: Vec2,
  wavelength: number,
  intensity: number,
  startTravel = 0,
  endTravel = 0
): void {
  pushVertex(output, lowerStart, wavelength, -1, intensity, startTravel);
  pushVertex(output, upperStart, wavelength, 1, intensity, startTravel);
  pushVertex(output, upperEnd, wavelength, 1, intensity, endTravel);
  pushVertex(output, lowerStart, wavelength, -1, intensity, startTravel);
  pushVertex(output, upperEnd, wavelength, 1, intensity, endTravel);
  pushVertex(output, lowerEnd, wavelength, -1, intensity, endTravel);
}

/** A cell whose two rails carry neighbouring wavelengths and intensities. */
function pushSpectralCell(
  output: number[],
  lowStart: Vec2,
  highStart: Vec2,
  lowEnd: Vec2,
  highEnd: Vec2,
  lowWavelength: number,
  highWavelength: number,
  lowIntensity: number,
  highIntensity: number
): void {
  pushVertex(output, lowStart, lowWavelength, 0, lowIntensity, 0);
  pushVertex(output, highStart, highWavelength, 0, highIntensity, 0);
  pushVertex(output, highEnd, highWavelength, 0, highIntensity, 1);
  pushVertex(output, lowStart, lowWavelength, 0, lowIntensity, 0);
  pushVertex(output, highEnd, highWavelength, 0, highIntensity, 1);
  pushVertex(output, lowEnd, lowWavelength, 0, lowIntensity, 1);
}

function pushEmptyQuad(output: number[]): void {
  pushQuad(output, [0, 0], [0, 0], [0, 0], [0, 0], -1, 0);
}

function profileCoordinates(slices: number): readonly number[] {
  return Array.from(
    { length: slices },
    (_, index) => -1 + (2 * (index + 0.5)) / slices
  );
}

/** Gaussian scattering profile with a zero-energy rim at the beam boundary. */
function normalizedProfileWeights(
  profiles: readonly number[],
  edgeFalloff: number
): readonly number[] {
  const weights = profiles.map((profile) => {
    const edge = Math.min(1, Math.max(0, (Math.abs(profile) - 0.55) / 0.45));
    const smooth = edge * edge * (3 - 2 * edge);
    return Math.exp(-edgeFalloff * profile * profile) * (1 - smooth);
  });
  const sum = weights.reduce((total, weight) => total + weight, 0) || 1;
  return weights.map((weight) => weight / sum);
}

function canConnect(a: SpectralNode, b: SpectralNode): boolean {
  return (
    matchingTopology(a.band.lower, b.band.lower) &&
    a.paths.every((path, index) => matchingTopology(path, b.paths[index]!))
  );
}

function densityReference(path: DetailedPrismPath): Vec2 {
  return add(path.origin, scale(path.direction, DENSITY_MEASURE_DISTANCE));
}

/**
 * Spectral energy density at one wavelength vertex.
 *
 * The finite difference estimates how much screen-space width a normalized
 * wavelength interval occupies. Dividing flux by that Jacobian keeps total
 * energy stable when the mesh is subdivided more finely.
 */
function spectralDensity(
  nodes: readonly (SpectralNode | undefined)[],
  nodeIndex: number,
  profileIndex: number,
  exposure: number,
  inputWidth: number,
  profileWeight: number
): number {
  const node = nodes[nodeIndex];
  if (!node) return 0;

  let left = nodeIndex - 1;
  while (left >= 0 && !nodes[left]) left--;
  let right = nodeIndex + 1;
  while (right < nodes.length && !nodes[right]) right++;
  if (left < 0) left = nodeIndex;
  if (right >= nodes.length) right = nodeIndex;
  if (left === right) return 0;

  const leftPath = nodes[left]!.paths[profileIndex]!;
  const rightPath = nodes[right]!.paths[profileIndex]!;
  if (!matchingTopology(leftPath, rightPath)) return 0;
  const direction = normalize(add(leftPath.direction, rightPath.direction));
  const spectralWidth = Math.abs(
    cross(
      sub(densityReference(rightPath), densityReference(leftPath)),
      direction
    )
  );
  const normalizedSpan = (right - left) / (nodes.length - 1);
  const jacobian = spectralWidth / normalizedSpan;
  return (
    (exposure *
      inputWidth *
      profileWeight *
      node.paths[profileIndex]!.transmission) /
    Math.max(jacobian, 1e-4)
  );
}

/** Build the white input and wavelength-connected spectral sheets. */
export function buildLightMesh(options: LightMeshOptions): LightMeshData {
  const triangle = options.triangle ?? PRISM_TRIANGLE;
  const samples = Math.max(
    2,
    Math.floor(options.samples ?? PRISM_SPECTRAL_SAMPLES)
  );
  const beamSlices = Math.max(
    1,
    Math.floor(options.beamSlices ?? PRISM_BEAM_SLICES)
  );
  const exposure = options.exposure ?? PRISM_LIGHT_EXPOSURE;
  const edgeFalloff = Math.max(
    0,
    options.edgeFalloff ?? DEFAULT_LIGHT_FADE_CONTROLS.edgeFalloff
  );
  const vertices: number[] = [];
  const inputWidth = options.light.beamHalfWidth * 2;
  const profiles = profileCoordinates(beamSlices);
  const profileWeights = normalizedProfileWeights(profiles, edgeFalloff);

  // Entry geometry is wavelength-independent. Use the middle of the spectrum to
  // obtain the two exact face intersections, then extend backwards to the frame.
  const middle = traceSpectralBand(
    triangle,
    options.light,
    options.dispersion,
    (PRISM_WAVELENGTHS.min + PRISM_WAVELENGTHS.max) * 0.5
  );
  if (middle) {
    const lowerEntry = middle.lower.points[0]!;
    const upperEntry = middle.upper.points[0]!;
    const backwards: Vec2 = [
      -options.light.direction[0],
      -options.light.direction[1],
    ];
    pushQuad(
      vertices,
      rayToWallBoundary(lowerEntry, backwards, options.wallHalfExtent),
      rayToWallBoundary(upperEntry, backwards, options.wallHalfExtent),
      lowerEntry,
      upperEntry,
      -1,
      INPUT_BEAM_RADIANCE,
    );
    // Dispersion inside this small prism is narrower than the beam itself, so
    // the spectrum still overlaps into white. Drawing the finite envelope once
    // avoids exposing the numerical beam slices as coloured hairlines.
    for (let segment = 0; segment < MAX_INTERNAL_SEGMENTS; segment++) {
      const lowerStart = middle.lower.points[segment];
      const lowerEnd = middle.lower.points[segment + 1];
      const upperStart = middle.upper.points[segment];
      const upperEnd = middle.upper.points[segment + 1];
      if (lowerStart && lowerEnd && upperStart && upperEnd) {
        pushQuad(
          vertices,
          lowerStart,
          upperStart,
          lowerEnd,
          upperEnd,
          -1,
          INTERNAL_BEAM_RADIANCE
        );
      } else {
        pushEmptyQuad(vertices);
      }
    }
  } else {
    pushEmptyQuad(vertices);
    for (let segment = 0; segment < MAX_INTERNAL_SEGMENTS; segment++)
      pushEmptyQuad(vertices);
  }

  const nodes: (SpectralNode | undefined)[] = [];
  let minOutputWidth = Number.POSITIVE_INFINITY;
  let maxOutputWidth = 0;
  for (let index = 0; index < samples; index++) {
    const wavelength =
      PRISM_WAVELENGTHS.min +
      (PRISM_WAVELENGTHS.max - PRISM_WAVELENGTHS.min) * (index / (samples - 1));
    const band = traceSpectralBand(
      triangle,
      options.light,
      options.dispersion,
      wavelength
    );
    if (!band) {
      nodes.push(undefined);
      continue;
    }
    const paths = profiles.map((profile) =>
      traceProfilePath(
        triangle,
        options.light,
        options.dispersion,
        wavelength,
        profile
      )
    );
    if (paths.some((path) => !path || !matchingTopology(band.lower, path))) {
      nodes.push(undefined);
      continue;
    }
    minOutputWidth = Math.min(minOutputWidth, band.outputWidth);
    maxOutputWidth = Math.max(maxOutputWidth, band.outputWidth);
    nodes.push({ wavelength, band, paths: paths as DetailedPrismPath[] });
  }

  const densities = nodes.map((node, nodeIndex) =>
    profiles.map((_, profileIndex) =>
      node
        ? spectralDensity(
            nodes,
            nodeIndex,
            profileIndex,
            exposure,
            inputWidth,
            profileWeights[profileIndex]!
          )
        : 0
    )
  );

  let totalFlux = 0;
  for (let interval = 0; interval < samples - 1; interval++) {
    const low = nodes[interval];
    const high = nodes[interval + 1];
    const connected = Boolean(low && high && canConnect(low, high));
    if (connected) {
      const lowTransmission = low!.paths.reduce(
        (sum, path, index) => sum + path.transmission * profileWeights[index]!,
        0
      );
      const highTransmission = high!.paths.reduce(
        (sum, path, index) => sum + path.transmission * profileWeights[index]!,
        0
      );
      totalFlux +=
        (exposure * inputWidth * (lowTransmission + highTransmission) * 0.5) /
        (samples - 1);
    }

    for (let profileIndex = 0; profileIndex < beamSlices; profileIndex++) {
      if (!connected) {
        pushQuad(vertices, [0, 0], [0, 0], [0, 0], [0, 0], -1, 0);
        continue;
      }
      const lowPath = low!.paths[profileIndex]!;
      const highPath = high!.paths[profileIndex]!;
      const lowIntensity = densities[interval]![profileIndex]!;
      const highIntensity = densities[interval + 1]![profileIndex]!;

      pushSpectralCell(
        vertices,
        lowPath.origin,
        highPath.origin,
        rayToWallBoundary(
          lowPath.origin,
          lowPath.direction,
          options.wallHalfExtent
        ),
        rayToWallBoundary(
          highPath.origin,
          highPath.direction,
          options.wallHalfExtent
        ),
        low!.wavelength,
        high!.wavelength,
        lowIntensity,
        highIntensity
      );
    }
  }

  const data = new Float32Array(vertices);
  const vertexCount = data.length / LIGHT_VERTEX_FLOATS;
  if (vertexCount !== lightVertexCount(samples, beamSlices)) {
    throw new Error(
      `Light mesh wrote ${vertexCount} vertices; expected ${lightVertexCount(
        samples,
        beamSlices
      )}.`
    );
  }
  const validBands = nodes.filter(Boolean).length;
  return {
    vertices: data,
    vertexCount,
    stats: {
      samples,
      beamSlices,
      validBands,
      rejectedTopology: samples - validBands,
      minOutputWidth: Number.isFinite(minOutputWidth) ? minOutputWidth : 0,
      maxOutputWidth,
      totalFlux,
    },
  };
}

/**
 * Deterministic geometry for the light itself.
 *
 * The mesh integrates two continuous dimensions. Wavelength vertices are
 * connected to their neighbours, so RGB can interpolate without visible bands.
 * Several additive spectral sheets sample the finite width of the collimated
 * beam, preserving the footprint that a single centre ray would collapse. Their
 * XY coordinates are lifted to a shared world-space depth by `light.wgsl`.
 */

import {
  intersectTriangle,
  iorAt,
  tracePrismDetailed,
  type DetailedPrismPath,
} from "./optics";
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
const whiteQuadCount = (beamSlices: number) =>
  (1 + MAX_INTERNAL_SEGMENTS) * beamSlices;
export const LIGHT_WHITE_QUADS = whiteQuadCount(PRISM_BEAM_SLICES);
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
  return (whiteQuadCount(beamSlices) + intervals * beamSlices) * VERTICES_PER_QUAD;
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
  readonly paths: readonly (DetailedPrismPath | undefined)[];
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, amount: number): Vec2 => [a[0] * amount, a[1] * amount];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
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

/** The portion of a forward ray that lies inside the wall rectangle. */
export function lineThroughWall(
  origin: Vec2,
  direction: Vec2,
  halfExtent: Vec2
): readonly [Vec2, Vec2] | undefined {
  let near = Number.NEGATIVE_INFINITY;
  let far = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 2; axis++) {
    const component = direction[axis]!;
    const coordinate = origin[axis]!;
    const extent = halfExtent[axis]!;
    if (Math.abs(component) < 1e-8) {
      if (Math.abs(coordinate) > extent) return undefined;
      continue;
    }
    const first = (-extent - coordinate) / component;
    const second = (extent - coordinate) / component;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return undefined;
  }
  near = Math.max(0, near);
  if (!Number.isFinite(near) || !Number.isFinite(far) || far < near)
    return undefined;
  return [add(origin, scale(direction, near)), add(origin, scale(direction, far))];
}

/** Exact overlap test between the forward finite beam strip and the triangle. */
export function beamIntersectsTriangle(
  triangle: Triangle,
  light: CollimatedLight
): boolean {
  const perpendicular: Vec2 = [-light.direction[1], light.direction[0]];
  let polygon: Vec2[] = [triangle.a, triangle.b, triangle.c].map((point) => {
    const offset = sub(point, light.center);
    return [
      offset[0] * light.direction[0] + offset[1] * light.direction[1],
      offset[0] * perpendicular[0] + offset[1] * perpendicular[1],
    ];
  });
  const clip = (inside: (point: Vec2) => number): void => {
    const input = polygon;
    polygon = [];
    for (let index = 0; index < input.length; index++) {
      const start = input[index]!;
      const end = input[(index + 1) % input.length]!;
      const startDistance = inside(start);
      const endDistance = inside(end);
      const startInside = startDistance >= 0;
      const endInside = endDistance >= 0;
      if (startInside) polygon.push(start);
      if (startInside === endInside) continue;
      const amount = startDistance / (startDistance - endDistance);
      polygon.push([
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ]);
    }
  };
  clip((point) => point[0]);
  if (polygon.length === 0) return false;
  clip((point) => point[1] + light.beamHalfWidth);
  if (polygon.length === 0) return false;
  clip((point) => light.beamHalfWidth - point[1]);
  return polygon.length > 0;
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
  endTravel = 0,
  lowerProfile = -1,
  upperProfile = 1
): void {
  pushVertex(output, lowerStart, wavelength, lowerProfile, intensity, startTravel);
  pushVertex(output, upperStart, wavelength, upperProfile, intensity, startTravel);
  pushVertex(output, upperEnd, wavelength, upperProfile, intensity, endTravel);
  pushVertex(output, lowerStart, wavelength, lowerProfile, intensity, startTravel);
  pushVertex(output, upperEnd, wavelength, upperProfile, intensity, endTravel);
  pushVertex(output, lowerEnd, wavelength, lowerProfile, intensity, endTravel);
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

function canConnect(
  a: SpectralNode | undefined,
  b: SpectralNode | undefined,
  profileIndex: number
): boolean {
  const aPath = a?.paths[profileIndex];
  const bPath = b?.paths[profileIndex];
  return Boolean(aPath && bPath && matchingTopology(aPath, bPath));
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
  const path = node?.paths[profileIndex];
  if (!path) return 0;

  let left = nodeIndex - 1;
  while (left >= 0 && !nodes[left]?.paths[profileIndex]) left--;
  let right = nodeIndex + 1;
  while (right < nodes.length && !nodes[right]?.paths[profileIndex]) right++;
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
      path.transmission) /
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

  // White light is sliced across its finite width too. This lets neighbouring
  // parts of a grazing beam enter different faces—or miss the prism—without
  // invalidating the rest of the beam.
  const middleWavelength = (PRISM_WAVELENGTHS.min + PRISM_WAVELENGTHS.max) * 0.5;
  const middleIor = iorAt(
    middleWavelength,
    options.dispersion.base,
    options.dispersion.strength
  );
  const boundaryProfiles = Array.from(
    { length: beamSlices + 1 },
    (_, index) => -1 + (2 * index) / beamSlices
  );
  const whiteBoundaries = boundaryProfiles.map((profile) => {
    const origin = beamProfileOrigin(options.light, profile);
    const hit = intersectTriangle(
      triangle,
      origin,
      options.light.direction,
      1e-4
    );
    const entry =
      hit && dot(options.light.direction, hit.normal) < 0
        ? add(origin, scale(options.light.direction, hit.t))
        : undefined;
    return {
      profile,
      origin,
      entry,
      wall: lineThroughWall(
        origin,
        options.light.direction,
        options.wallHalfExtent
      ),
      path: tracePrismDetailed(
        triangle,
        origin,
        options.light.direction,
        middleIor
      ),
    };
  });
  const backwards: Vec2 = [
    -options.light.direction[0],
    -options.light.direction[1],
  ];
  for (let slice = 0; slice < beamSlices; slice++) {
    const lower = whiteBoundaries[slice]!;
    const upper = whiteBoundaries[slice + 1]!;
    if (lower.entry && upper.entry) {
      pushQuad(
        vertices,
        rayToWallBoundary(lower.entry, backwards, options.wallHalfExtent),
        rayToWallBoundary(upper.entry, backwards, options.wallHalfExtent),
        lower.entry,
        upper.entry,
        -1,
        INPUT_BEAM_RADIANCE,
        0,
        0,
        lower.profile,
        upper.profile
      );
    } else {
      const centerProfile = (lower.profile + upper.profile) * 0.5;
      const cellLight: CollimatedLight = {
        center: beamProfileOrigin(options.light, centerProfile),
        direction: options.light.direction,
        beamHalfWidth:
          options.light.beamHalfWidth * (upper.profile - lower.profile) * 0.5,
      };
      if (
        !beamIntersectsTriangle(triangle, cellLight) &&
        lower.wall &&
        upper.wall
      ) {
        pushQuad(
          vertices,
          lower.wall[0],
          upper.wall[0],
          lower.wall[1],
          upper.wall[1],
          -1,
          INPUT_BEAM_RADIANCE,
          0,
          0,
          lower.profile,
          upper.profile
        );
      } else {
        pushEmptyQuad(vertices);
      }
    }

    const connectedInternal = Boolean(
      lower.path && upper.path && matchingTopology(lower.path, upper.path)
    );
    for (let segment = 0; segment < MAX_INTERNAL_SEGMENTS; segment++) {
      const lowerStart = lower.path?.points[segment];
      const lowerEnd = lower.path?.points[segment + 1];
      const upperStart = upper.path?.points[segment];
      const upperEnd = upper.path?.points[segment + 1];
      if (
        connectedInternal &&
        lowerStart &&
        lowerEnd &&
        upperStart &&
        upperEnd
      ) {
        pushQuad(
          vertices,
          lowerStart,
          upperStart,
          lowerEnd,
          upperEnd,
          -1,
          INTERNAL_BEAM_RADIANCE,
          0,
          0,
          lower.profile,
          upper.profile
        );
      } else {
        pushEmptyQuad(vertices);
      }
    }
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
    const paths = profiles.map((profile) =>
      traceProfilePath(
        triangle,
        options.light,
        options.dispersion,
        wavelength,
        profile
      )
    );
    if (paths.every((path) => !path)) {
      nodes.push(undefined);
      continue;
    }
    if (band) {
      minOutputWidth = Math.min(minOutputWidth, band.outputWidth);
      maxOutputWidth = Math.max(maxOutputWidth, band.outputWidth);
    }
    nodes.push({ wavelength, paths });
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

    for (let profileIndex = 0; profileIndex < beamSlices; profileIndex++) {
      const connected = canConnect(low, high, profileIndex);
      if (!connected) {
        pushQuad(vertices, [0, 0], [0, 0], [0, 0], [0, 0], -1, 0);
        continue;
      }
      const lowPath = low!.paths[profileIndex]!;
      const highPath = high!.paths[profileIndex]!;
      const lowIntensity = densities[interval]![profileIndex]!;
      const highIntensity = densities[interval + 1]![profileIndex]!;
      totalFlux +=
        (exposure *
          inputWidth *
          profileWeights[profileIndex]! *
          (lowPath.transmission + highPath.transmission) *
          0.5) /
        (samples - 1);

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

// Procedural lensed star field with anisotropic footprint prefiltering.

import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

const STAR_INTENSITY: f32 = 1.9;

const ANCHOR_CELLS: f32 = 36.0;
const ANCHOR_FILL: f32 = 0.75;
const ANCHOR_RADIUS: f32 = 0.00110;
const ANCHOR_PEAK: f32 = 1.0;

const FIELD_CELLS: f32 = 93.0;
const FIELD_FILL: f32 = 0.75;
const FIELD_RADIUS: f32 = 0.00070;
const FIELD_PEAK: f32 = 0.45;

const DUST_CELLS: f32 = 151.0;
const DUST_FILL: f32 = 0.75;
const DUST_RADIUS: f32 = 0.00040;
const DUST_PEAK: f32 = 0.22;

const COUNT_SLOPE: f32 = 2.0;

const STAR_FLUX_AREA: f32 = 0.5385;

const MAX_PREFILTER_PIXELS: f32 = 4.0;

const STAR_WARM: vec3f = vec3f(1.1741, 0.9745, 0.7397);
const STAR_COOL: vec3f = vec3f(0.8954, 1.0131, 1.1781);

export struct StarLook {
  brightness: f32,
  density: f32,
  contrast: f32,
  warmth: f32,
  twinkle: f32,
}

fn faceCoords(direction: vec3f) -> vec3f {
  let magnitude = abs(direction);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    return vec3f(direction.yz / magnitude.x, select(1.0, 0.0, direction.x > 0.0));
  }
  if (magnitude.y >= magnitude.z) {
    return vec3f(direction.xz / magnitude.y, select(3.0, 2.0, direction.y > 0.0));
  }
  return vec3f(direction.xy / magnitude.z, select(5.0, 4.0, direction.z > 0.0));
}

fn faceProject(direction: vec3f, axis: i32) -> vec2f {
  if (axis == 0) {
    return direction.yz / abs(direction.x);
  }
  if (axis == 1) {
    return direction.xz / abs(direction.y);
  }
  return direction.xy / abs(direction.z);
}

struct SkyFilter {
  inverseJacobian: mat2x2f,
  pixelsPerFace: f32,
  faceMajor: f32,
}

fn skyFilter(direction: vec3f, axis: i32, ddx: vec3f, ddy: vec3f) -> SkyFilter {
  let base = faceProject(direction, axis);
  let jx = faceProject(direction + ddx, axis) - base;
  let jy = faceProject(direction + ddy, axis) - base;

  let determinant = jx.x * jy.y - jx.y * jy.x;
  let safeDeterminant = select(determinant, 1.0e-24, abs(determinant) < 1.0e-24);
  let inverse = mat2x2f(vec2f(jy.y, -jx.y), vec2f(-jy.x, jx.x)) * (1.0 / safeDeterminant);

  var prefilter: SkyFilter;
  prefilter.inverseJacobian = inverse;
  prefilter.pixelsPerFace = 1.0 / sqrt(max(abs(determinant), 1.0e-24));
  prefilter.faceMajor = max(length(jx), length(jy));
  return prefilter;
}

struct SkyState {
  brightness: f32,
  rangePower: f32,
  meanFlux: f32,
  warmth: f32,
  twinkle: f32,
  time: f32,
  fillScale: f32,
  radiusScale: f32,
}

fn resolveSky(look: StarLook, face: vec2f, time: f32) -> SkyState {
  let range = clamp(look.contrast, 1.0, 512.0);
  let rangePower = range * range;

  let compression = 1.0 + dot(face, face);
  let root = sqrt(compression);

  var sky: SkyState;
  sky.brightness = max(0.0, look.brightness) * STAR_INTENSITY;
  sky.rangePower = rangePower;
  sky.meanFlux = COUNT_SLOPE / (range + COUNT_SLOPE - 1.0);
  sky.warmth = clamp(look.warmth, 0.0, 1.0);
  sky.twinkle = clamp(look.twinkle, 0.0, 1.0);
  sky.time = time;
  sky.fillScale = max(0.0, look.density) / (compression * root);
  sky.radiusScale = sqrt(compression * root);
  return sky;
}

struct Species {
  cells: f32,
  fill: f32,
  peak: f32,
  faceRadius: f32,
  radiusPixels: f32,
  gain: f32,
}

fn resolveSpecies(
  cells: f32,
  fill: f32,
  peak: f32,
  angularRadius: f32,
  sky: SkyState,
  prefilter: SkyFilter,
) -> Species {
  let faceRadius = angularRadius * sky.radiusScale;
  let starPixels = faceRadius * prefilter.pixelsPerFace;

  var species: Species;
  species.cells = cells;
  species.fill = clamp(fill * sky.fillScale, 0.0, 1.0);
  species.peak = peak * sky.brightness;
  species.faceRadius = faceRadius;
  species.radiusPixels = clamp(starPixels, 1.0, MAX_PREFILTER_PIXELS);
  species.gain = min(1.0, starPixels * starPixels);
  return species;
}

fn starPoint(
  cell: vec2f,
  grid: vec2f,
  faceIndex: i32,
  seed: i32,
  species: Species,
  sky: SkyState,
  prefilter: SkyFilter,
) -> vec3f {
  let hashed = pcg3d(bitcast<vec3u>(vec3i(vec2i(cell), faceIndex * 131 + seed)));
  let presence = unitFloat(hashed.x);
  if (presence > species.fill) {
    return vec3f(0.0);
  }

  let jitter = vec2f(unitFloat(hashed.y), unitFloat(hashed.z)) - vec2f(0.5);
  let center = cell + vec2f(0.5) + jitter * 0.8;
  let offsetPixels = prefilter.inverseJacobian * ((grid - center) / species.cells);
  let falloff = 1.0 - smoothstep(0.0, species.radiusPixels, length(offsetPixels));

  let uniform01 = presence / max(species.fill, 1.0e-6);
  let flux = inverseSqrt(1.0 + uniform01 * (sky.rangePower - 1.0));

  let tint = mix(vec3f(1.0), mix(STAR_WARM, STAR_COOL, unitFloat(hashed.y ^ hashed.z)), sky.warmth);

  let phase = unitFloat(hashed.y) * 6.2831853;
  let shimmer = 1.0 + sky.twinkle * 0.06 * sin(sky.time * (0.35 + unitFloat(hashed.z) * 0.4) + phase);
  return tint * (falloff * falloff * species.peak * flux * shimmer * species.gain);
}

fn starSpecies(
  face: vec3f,
  seed: i32,
  species: Species,
  sky: SkyState,
  prefilter: SkyFilter,
) -> vec3f {
  let faceIndex = i32(face.z);
  let grid = face.xy * species.cells;
  let total = starPoint(floor(grid), grid, faceIndex, seed, species, sky, prefilter);

  let extent = species.faceRadius * species.cells;
  let mean = species.peak * sky.meanFlux * species.fill * STAR_FLUX_AREA * extent * extent;
  let meanTint = mix(vec3f(1.0), 0.5 * (STAR_WARM + STAR_COOL), sky.warmth);
  let cellsPerPixel = species.cells * prefilter.faceMajor;
  return mix(total, meanTint * mean, smoothstep(1.0, 3.0, cellsPerPixel));
}

export fn shadeStars(direction: vec3f, look: StarLook, time: f32, ddx: vec3f, ddy: vec3f) -> vec3f {
  let d = normalize(direction);
  let face = faceCoords(d);
  let prefilter = skyFilter(d, i32(face.z) / 2, ddx, ddy);
  let sky = resolveSky(look, face.xy, time);

  return starSpecies(
    face, 17,
    resolveSpecies(ANCHOR_CELLS, ANCHOR_FILL, ANCHOR_PEAK, ANCHOR_RADIUS, sky, prefilter),
    sky, prefilter,
  ) + starSpecies(
    face, 71,
    resolveSpecies(FIELD_CELLS, FIELD_FILL, FIELD_PEAK, FIELD_RADIUS, sky, prefilter),
    sky, prefilter,
  ) + starSpecies(
    face, 149,
    resolveSpecies(DUST_CELLS, DUST_FILL, DUST_PEAK, DUST_RADIUS, sky, prefilter),
    sky, prefilter,
  );
}

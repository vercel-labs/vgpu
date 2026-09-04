// Deterministic star field: five procedural spiral strokes plus a core
// cluster. Everything is generated once on the CPU with seeded randomness, so
// every reload (and the thumbnail) produces the same field, then uploaded as
// storage buffers the compute pass reads every frame.
//
// Inspired by the star-field hero on openai.com/index/gpt-6-astra; the
// strokes, palette and code here are original.

export const PATH_SAMPLES = 512;
/** Floats per `Star` in simulate.wgsl (96 bytes). */
export const STAR_FLOATS = 24;
/** Floats per `Layer` in simulate.wgsl (32 bytes). */
export const LAYER_FLOATS = 8;
/** Floats per `Projected` in stars.wgsl (48 bytes). */
export const PROJECTED_FLOATS = 12;
/** Flare source slots: one per stroke layer plus the core. */
export const MAX_FLARE_SOURCES = 8;

export interface StrokeSpec {
  /** Start angle in radians; the stroke winds inward as t grows. */
  readonly theta: number;
  readonly sweep: number;
  readonly outerRadius: number;
  readonly innerRadius: number;
  /** Depth wave amplitude in world units, scaled by `rotationDepth`. */
  readonly depth: number;
  /** Flow speed in stroke lengths per second, before `flowSpeed`. */
  readonly speed: number;
  readonly strong: boolean;
}

// Log-spiral arms around the core; the three strong strokes carry the eye,
// the two weak ones fill the gaps.
export const STROKES: readonly StrokeSpec[] = [
  { theta: 0.35 * Math.PI, sweep: 1.7 * Math.PI, outerRadius: 5.3, innerRadius: 0.75, depth: 0.62, speed: 0.025, strong: true },
  { theta: 1.35 * Math.PI, sweep: 1.45 * Math.PI, outerRadius: 4.7, innerRadius: 1.1, depth: -0.46, speed: 0.018, strong: false },
  { theta: 0.85 * Math.PI, sweep: 1.9 * Math.PI, outerRadius: 3.7, innerRadius: 0.55, depth: 0.78, speed: 0.021, strong: true },
  { theta: 1.85 * Math.PI, sweep: 1.6 * Math.PI, outerRadius: 3.2, innerRadius: 0.8, depth: -0.7, speed: 0.016, strong: false },
  { theta: 0.1 * Math.PI, sweep: 2.3 * Math.PI, outerRadius: 1.9, innerRadius: 0.2, depth: 0.42, speed: 0.03, strong: true },
];

/** sRGB palette; converted to linear when written into the star buffer. */
export const PALETTE = ['#7fd4ff', '#8ab4ff', '#ff8a2a', '#ffb15c', '#f7f8ff'] as const;
/** Palette seed of each stroke's hero star, so every flare source has its own tint. */
const HERO_COLOR_SEEDS = [0.08, 0.58, 0.22, 0.68, 0.44];

const SQUASH = 0.74;
const TILT = -0.42;

export interface FieldOptions {
  /** Stars per stroke = (strong ? 220 : 170) × density. */
  readonly density?: number;
  readonly starSize?: number;
  readonly scatter?: number;
  readonly densityFalloff?: number;
  readonly rotationDepth?: number;
  readonly centerCluster?: boolean;
  /** Keeps 12% extra stars in the sky after the intro converges. */
  readonly backgroundStars?: boolean;
  readonly palette?: readonly string[];
}

export interface LayerInfo {
  readonly index: number;
  readonly isCore: boolean;
  readonly strong: boolean;
  /** Stroke lengths per second; 0 for the core cluster. */
  readonly speed: number;
  /** Rotation lag against the drag: outer strokes trail the inner ones. */
  readonly lag: number;
  /** Offset into `paths`, in vec4 samples. */
  readonly sampleBase: number;
  readonly heroIndex: number;
  readonly starCount: number;
}

export interface StarField {
  readonly count: number;
  readonly stars: Float32Array<ArrayBuffer>;
  readonly paths: Float32Array<ArrayBuffer>;
  readonly layers: readonly LayerInfo[];
  /** Layer index of the core cluster, or -1 when disabled. */
  readonly coreLayer: number;
}

/** Mulberry32: tiny seeded generator, stable across reloads and platforms. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    let t = (state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smoothstep(x: number, edge0: number, edge1: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

/** Bunches stars toward the middle of a stroke (`densityFalloff`). */
export function densityProgress(t: number, falloff: number): number {
  const p = positiveModulo(t, 1);
  return p + (clamp(falloff, 0, 0.98) * Math.sin(p * Math.PI * 2)) / (2 * Math.PI);
}

/** Classic sine hash, evaluated in double precision so seeds are portable. */
export function hash2(a: number, b: number, x: number, y: number): number {
  const v = 43758.5453 * Math.sin(a * x + b * y);
  return v - Math.floor(v);
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function parseColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [
    srgbToLinear(((value >> 16) & 255) / 255),
    srgbToLinear(((value >> 8) & 255) / 255),
    srgbToLinear((value & 255) / 255),
  ];
}

/** Palette bands are 36 / 16 / 12 / 10 / 26 percent of the seed range. */
export function paletteColor(seed: number, palette: readonly string[] = PALETTE): [number, number, number] {
  const index = seed < 0.36 ? 0 : seed < 0.52 ? 1 : seed < 0.64 ? 2 : seed < 0.74 ? 3 : 4;
  return parseColor(palette[index] ?? palette[palette.length - 1] ?? '#ffffff');
}

/** Heavier stars resist the pointer more; matches the star size range 1–14 px. */
export function repelMass(size: number): number {
  return lerp(0.65, 2.4, smoothstep(size, 1, 14));
}

function strokePoint(spec: StrokeSpec, t: number, out: [number, number]): [number, number] {
  const theta = spec.theta + t * spec.sweep;
  const radius =
    lerp(spec.outerRadius, spec.innerRadius, t ** 0.92) *
    (1 + 0.05 * Math.sin(3.1 * theta + spec.depth * 4));
  const x = Math.cos(theta) * radius;
  const y = Math.sin(theta) * radius * SQUASH;
  const c = Math.cos(TILT);
  const s = Math.sin(TILT);
  out[0] = x * c - y * s;
  out[1] = x * s + y * c;
  return out;
}

/**
 * Resamples a stroke by arc length into `PATH_SAMPLES` xyz points and adds the
 * depth wave that gives the field its parallax when rotated.
 */
export function buildPath(spec: StrokeSpec, layerIndex: number, rotationDepth: number): Float32Array<ArrayBuffer> {
  const fine = 2048;
  const xs = new Float64Array(fine + 1);
  const ys = new Float64Array(fine + 1);
  const lengths = new Float64Array(fine + 1);
  const point: [number, number] = [0, 0];
  for (let i = 0; i <= fine; i += 1) {
    strokePoint(spec, i / fine, point);
    xs[i] = point[0];
    ys[i] = point[1];
    if (i > 0) lengths[i] = lengths[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
  }
  const total = lengths[fine]!;
  const samples = new Float32Array(PATH_SAMPLES * 4);
  const depthPhase = 0.82 * layerIndex;
  let segment = 0;
  for (let k = 0; k < PATH_SAMPLES; k += 1) {
    const u = k / (PATH_SAMPLES - 1);
    const target = u * total;
    while (segment < fine - 1 && lengths[segment + 1]! < target) segment += 1;
    const span = Math.max(lengths[segment + 1]! - lengths[segment]!, 1e-9);
    const blend = clamp((target - lengths[segment]!) / span, 0, 1);
    const envelope = Math.sin(u * Math.PI);
    samples[4 * k] = lerp(xs[segment]!, xs[segment + 1]!, blend);
    samples[4 * k + 1] = lerp(ys[segment]!, ys[segment + 1]!, blend);
    samples[4 * k + 2] = Math.sin(u * Math.PI * 1.35 + depthPhase) * spec.depth * rotationDepth * envelope;
    samples[4 * k + 3] = 1;
  }
  return samples;
}

export function samplePath(samples: Float32Array, base: number, t: number, out: [number, number, number]): [number, number, number] {
  const scaled = clamp(t, 0, 1) * (PATH_SAMPLES - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(lower + 1, PATH_SAMPLES - 1);
  const blend = scaled - lower;
  const a = 4 * (base + lower);
  const b = 4 * (base + upper);
  out[0] = lerp(samples[a]!, samples[b]!, blend);
  out[1] = lerp(samples[a + 1]!, samples[b + 1]!, blend);
  out[2] = lerp(samples[a + 2]!, samples[b + 2]!, blend);
  return out;
}

interface StarWriter {
  readonly data: Float32Array<ArrayBuffer>;
  index: number;
}

function writeStar(
  writer: StarWriter,
  values: {
    position: readonly [number, number, number];
    layer: number;
    progress: number;
    across: number;
    depth: number;
    brightness: number;
    scale: number;
    opacity: number;
    twinklePhase: number;
    twinkleRate: number;
    color: readonly [number, number, number];
    hero: number;
    background: number;
  },
): number {
  const o = writer.index * STAR_FLOATS;
  const d = writer.data;
  d[o] = values.position[0];
  d[o + 1] = values.position[1];
  d[o + 2] = values.position[2];
  d[o + 3] = values.layer;
  d[o + 4] = values.progress;
  d[o + 5] = values.across;
  d[o + 6] = values.depth;
  d[o + 7] = values.brightness;
  d[o + 8] = values.scale;
  d[o + 9] = values.opacity;
  d[o + 10] = values.twinklePhase;
  d[o + 11] = values.twinkleRate;
  d[o + 12] = values.color[0];
  d[o + 13] = values.color[1];
  d[o + 14] = values.color[2];
  d[o + 15] = values.hero;
  d[o + 16] = values.background;
  d[o + 17] = repelMass(0.35 + 3.8 * values.scale);
  // Scatter seeds: where the star sits in the sky before the intro pulls it in.
  d[o + 18] = hash2(values.progress, values.twinklePhase, 127.1, 311.7);
  d[o + 19] = hash2(values.twinklePhase, values.scale, 269.5, 183.3);
  d[o + 20] = hash2(values.progress, values.brightness, 419.2, 371.9);
  d[o + 21] = hash2(values.opacity, values.twinkleRate, 157.3, 283.9);
  return writer.index++;
}

export function starCountFor(spec: StrokeSpec, density: number): number {
  return Math.max(8, Math.round((spec.strong ? 220 : 170) * density));
}

export function backgroundCountFor(starCount: number, enabled: boolean): number {
  return enabled ? Math.ceil((0.12 * starCount) / 0.88) : 0;
}

/** Builds the star layers along the spiral strokes plus the center cluster. */
export function generateField(options: FieldOptions = {}): StarField {
  const density = clamp(options.density ?? 4, 0.25, 6);
  const starSize = clamp(options.starSize ?? 1.5, 0.25, 3);
  const scatter = clamp(options.scatter ?? 0.4, 0, 0.45);
  const falloff = clamp(options.densityFalloff ?? 0.22, 0, 1);
  const rotationDepth = clamp(options.rotationDepth ?? 1.4, 0, 2);
  const palette = options.palette ?? PALETTE;
  const centerCluster = options.centerCluster ?? true;
  const backgroundStars = options.backgroundStars ?? true;

  const counts = STROKES.map((spec) => starCountFor(spec, density));
  const backgrounds = counts.map((count) => backgroundCountFor(count, backgroundStars));
  const clusterCount = centerCluster ? Math.max(18, Math.round(24 * density)) : 0;
  const total = counts.reduce((a, b) => a + b, 0) + backgrounds.reduce((a, b) => a + b, 0) + clusterCount;

  const writer: StarWriter = { data: new Float32Array(total * STAR_FLOATS), index: 0 };
  const paths = new Float32Array(STROKES.length * PATH_SAMPLES * 4);
  const layers: LayerInfo[] = [];
  const point: [number, number, number] = [0, 0, 0];
  const before: [number, number, number] = [0, 0, 0];
  const after: [number, number, number] = [0, 0, 0];

  STROKES.forEach((spec, layerIndex) => {
    const sampleBase = layerIndex * PATH_SAMPLES;
    paths.set(buildPath(spec, layerIndex, rotationDepth), sampleBase * 4);
    const rand = mulberry32(0x243f6a88 ^ ((layerIndex + 1) * 0x9e3779b9));
    const colorRand = mulberry32(0xa4093822 ^ ((layerIndex + 1) * 0x299f31d0));
    const starCount = counts[layerIndex]!;
    const count = starCount + backgrounds[layerIndex]!;
    const first = writer.index;
    let heroIndex = first;
    let bestScale = -Infinity;
    const step = 1 / (PATH_SAMPLES - 1);

    for (let i = 0; i < count; i += 1) {
      const seed = rand();
      const progress = densityProgress(seed, falloff);
      const mid = Math.sin(clamp(progress, 0, 1) * Math.PI);
      samplePath(paths, sampleBase, progress, point);
      samplePath(paths, sampleBase, Math.max(progress - step, 0), before);
      samplePath(paths, sampleBase, Math.min(progress + step, 1), after);
      const tx = after[0] - before[0];
      const ty = after[1] - before[1];
      const tl = Math.hypot(tx, ty) || 1;
      const acrossX = -ty / tl;
      const acrossY = tx / tl;
      const spread = scatter * lerp(0.3, 1, mid) * (0.22 + 0.78 * rand());
      const acrossOffset = (rand() + rand() - 1) * spread;
      const depthOffset = (rand() + rand() - 1) * spread * 0.65;
      const brightBase = spec.strong ? 0.085 : 0.055;
      const bright = rand() < lerp(brightBase * 0.22, brightBase, mid);
      const scale = (bright ? 0.85 + 1.25 * rand() : 0.12 + rand() ** 2.4 * 0.68) * starSize;
      const brightness = (bright ? 2 + 1.5 * rand() : 0.56 + 0.78 * rand()) * (spec.strong ? 1 : 0.82);
      const index = writeStar(writer, {
        position: [point[0] + acrossX * acrossOffset, point[1] + acrossY * acrossOffset, point[2] + depthOffset],
        layer: layerIndex,
        progress: seed,
        across: acrossOffset,
        depth: depthOffset,
        brightness,
        scale,
        opacity: 0.82 + 0.16 * rand(),
        twinklePhase: rand() * Math.PI * 2,
        twinkleRate: 0.65 + 0.7 * rand(),
        color: paletteColor(colorRand(), palette),
        hero: 0,
        background: i < starCount ? 0 : 1,
      });
      if (i < starCount && scale > bestScale) {
        bestScale = scale;
        heroIndex = index;
      }
    }

    // The brightest star of each stroke is the tracked hero that drives a flare.
    const h = heroIndex * STAR_FLOATS;
    writer.data[h + 8] = Math.max(writer.data[h + 8]!, (spec.strong ? 2.2 : 2.05) * starSize);
    writer.data[h + 7] = Math.max(writer.data[h + 7]!, spec.strong ? 3.35 : 2.85);
    writer.data[h + 15] = 1;
    writer.data[h + 17] = repelMass(0.35 + 3.8 * writer.data[h + 8]!);
    const heroColor = paletteColor(HERO_COLOR_SEEDS[layerIndex] ?? 0.08, palette);
    writer.data[h + 12] = heroColor[0];
    writer.data[h + 13] = heroColor[1];
    writer.data[h + 14] = heroColor[2];

    layers.push({
      index: layerIndex,
      isCore: false,
      strong: spec.strong,
      speed: Math.abs(spec.speed),
      lag: 0.18 + 0.17 * layerIndex,
      sampleBase,
      heroIndex,
      starCount: count,
    });
  });

  let coreLayer = -1;
  if (clusterCount > 0) {
    const layerIndex = layers.length;
    coreLayer = layerIndex;
    const rand = mulberry32(0xb7e15162);
    const colorRand = mulberry32(0xc0ac29b7);
    let heroIndex = writer.index;
    let best = -Infinity;
    for (let i = 0; i < clusterCount; i += 1) {
      const radius = rand() ** 2.4 * 0.42;
      const angle = rand() * Math.PI * 2;
      const z = (rand() - 0.5) * 0.16;
      const centrality = 1 - radius / 0.42;
      const brightness = 1.2 + 2.8 * centrality + 0.6 * rand();
      const colorSeed = centrality > 0.74 ? 0.99 : colorRand();
      const scale = (0.28 + 1.45 * centrality + 0.45 * rand()) * starSize * 0.8;
      const index = writeStar(writer, {
        position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, z],
        layer: layerIndex,
        progress: 0,
        across: 0,
        depth: 0,
        brightness,
        scale,
        opacity: 0.62 + 0.38 * centrality,
        twinklePhase: rand() * Math.PI * 2,
        twinkleRate: 0.55 + 0.45 * rand(),
        color: paletteColor(colorSeed, palette),
        hero: 0,
        background: 0,
      });
      if (brightness * scale > best) {
        best = brightness * scale;
        heroIndex = index;
      }
    }
    writer.data[heroIndex * STAR_FLOATS + 15] = 1;
    layers.push({
      index: layerIndex,
      isCore: true,
      strong: true,
      speed: 0,
      lag: 0,
      sampleBase: 0,
      heroIndex,
      starCount: clusterCount,
    });
  }

  return { count: total, stars: writer.data, paths, layers, coreLayer };
}

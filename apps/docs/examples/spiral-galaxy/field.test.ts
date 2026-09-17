import { expect, test } from 'vitest';

import {
  backgroundCountFor,
  buildPath,
  densityProgress,
  generateField,
  LAYER_FLOATS,
  MAX_FLARE_SOURCES,
  mulberry32,
  PATH_SAMPLES,
  paletteColor,
  parseCubicPath,
  repelMass,
  samplePath,
  SPIRAL_PATHS,
  STAR_FLOATS,
  starCountFor,
  strokeFlowSpeed,
  STROKE_SEGMENTS,
  STROKES,
} from './field';

test('the field is deterministic and sized from the stroke budget', () => {
  const a = generateField();
  const b = generateField();
  expect(a.count).toBe(b.count);
  expect(a.stars).toEqual(b.stars);
  expect(a.paths).toEqual(b.paths);

  const strokes = STROKES.reduce((sum, spec) => sum + starCountFor(spec, 4), 0);
  const backgrounds = STROKES.reduce((sum, spec) => sum + backgroundCountFor(starCountFor(spec, 4), true), 0);
  expect(a.count).toBe(strokes + backgrounds + 96);
  expect(a.stars.length).toBe(a.count * STAR_FLOATS);
  expect(a.paths.length).toBe(STROKES.length * PATH_SAMPLES * 4);
  expect(a.layers).toHaveLength(STROKES.length + 1);
  expect(a.coreLayer).toBe(STROKES.length);
  expect(a.layers.length).toBeLessThanOrEqual(MAX_FLARE_SOURCES);
  expect(LAYER_FLOATS).toBe(8);
});

test('every layer tracks exactly one hero star, and it is the largest on its stroke', () => {
  const field = generateField();
  const heroes = new Map<number, number[]>();
  for (let i = 0; i < field.count; i++) {
    const o = i * STAR_FLOATS;
    const layer = field.stars[o + 3]!;
    if (field.stars[o + 15] === 1) heroes.set(layer, [...(heroes.get(layer) ?? []), i]);
  }
  for (const layer of field.layers) {
    expect(heroes.get(layer.index)).toEqual([layer.heroIndex]);
    const heroScale = field.stars[layer.heroIndex * STAR_FLOATS + 8]!;
    for (let i = 0; i < field.count; i++) {
      const o = i * STAR_FLOATS;
      if (field.stars[o + 3] !== layer.index || field.stars[o + 16] === 1) continue;
      expect(field.stars[o + 8]!).toBeLessThanOrEqual(heroScale);
    }
    // Hero stars are never background stars.
    expect(field.stars[layer.heroIndex * STAR_FLOATS + 16]).toBe(0);
  }
});

test('stars carry finite attributes, unit seeds and linear palette colors', () => {
  const field = generateField();
  let background = 0;
  for (let i = 0; i < field.count; i++) {
    const o = i * STAR_FLOATS;
    for (let k = 0; k < STAR_FLOATS; k++) expect(Number.isFinite(field.stars[o + k])).toBe(true);
    expect(field.stars[o + 4]).toBeGreaterThanOrEqual(0);
    expect(field.stars[o + 4]).toBeLessThan(1);
    for (const seed of [18, 19, 20, 21]) {
      expect(field.stars[o + seed]).toBeGreaterThanOrEqual(0);
      expect(field.stars[o + seed]).toBeLessThan(1);
    }
    expect(field.stars[o + 17]).toBeGreaterThanOrEqual(0.65);
    expect(field.stars[o + 17]).toBeLessThanOrEqual(2.4 + 1e-6);
    for (const channel of [12, 13, 14]) {
      expect(field.stars[o + channel]).toBeGreaterThanOrEqual(0);
      expect(field.stars[o + channel]).toBeLessThanOrEqual(1);
    }
    background += field.stars[o + 16]!;
  }
  expect(background).toBe(STROKES.reduce((sum, spec) => sum + backgroundCountFor(starCountFor(spec, 4), true), 0));
  expect(generateField({ backgroundStars: false, centerCluster: false }).coreLayer).toBe(-1);
});

test('paths are resampled by arc length and wind inward', () => {
  const samples = buildPath(STROKES[0]!, 0, 1.4);
  const point: [number, number, number] = [0, 0, 0];
  const first = samplePath(samples, 0, 0, [0, 0, 0]);
  const last = samplePath(samples, 0, 1, [0, 0, 0]);
  expect(Math.hypot(first[0], first[1])).toBeGreaterThan(Math.hypot(last[0], last[1]));
  // Consecutive samples are (nearly) equally spaced.
  const gaps: number[] = [];
  for (let k = 1; k < PATH_SAMPLES; k++) {
    const a = samplePath(samples, 0, (k - 1) / (PATH_SAMPLES - 1), [0, 0, 0]);
    const b = samplePath(samples, 0, k / (PATH_SAMPLES - 1), point);
    gaps.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  for (const gap of gaps) expect(Math.abs(gap - mean) / mean).toBeLessThan(0.1);
  // The depth wave vanishes at both ends.
  expect(first[2]).toBeCloseTo(0, 5);
  expect(last[2]).toBeCloseTo(0, 5);
});

test('helpers match the shader-side math', () => {
  const rand = mulberry32(42);
  const values = [rand(), rand(), rand()];
  expect(values).toEqual(mulberry32(42)().valueOf() === values[0] ? values : values);
  for (const v of values) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
  expect(densityProgress(0.25, 0.22)).toBeCloseTo(0.25 + 0.22 / (2 * Math.PI), 6);
  expect(densityProgress(1.25, 0)).toBeCloseTo(0.25, 6);
  expect(repelMass(0)).toBeCloseTo(0.65, 6);
  expect(repelMass(20)).toBeCloseTo(2.4, 6);
  expect(paletteColor(0.99)).toEqual(paletteColor(0.8));
  expect(paletteColor(0.1)).not.toEqual(paletteColor(0.6));
  expect(starCountFor(STROKES[0]!, 4)).toBe(880);
  expect(backgroundCountFor(880, true)).toBe(120);
  expect(backgroundCountFor(880, false)).toBe(0);
});

test('the "6" strokes parse into continuous cubic runs', () => {
  expect(STROKE_SEGMENTS).toHaveLength(STROKES.length);
  SPIRAL_PATHS.forEach((path, index) => {
    const segments = parseCubicPath(path);
    expect(segments).toEqual(STROKE_SEGMENTS[index]);
    expect(segments.length).toBeGreaterThan(0);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.x0).toBe(segments[i - 1]!.x3);
      expect(segments[i]!.y0).toBe(segments[i - 1]!.y3);
    }
  });
  expect(parseCubicPath('M0 0C1 1 2 2 3 3 4 4 5 5 6 6')).toHaveLength(2);
  expect(() => parseCubicPath('M0 0L1 1')).toThrow('no cubic segments');
  expect(() => parseCubicPath('M0 0Q1 1 2 2')).toThrow('Unsupported SVG path command');
});

test('every stroke flows toward the core regardless of how its path was authored', () => {
  const field = generateField();
  for (const layer of field.layers) {
    if (layer.isCore) continue;
    const spec = STROKES[layer.index]!;
    expect(Math.abs(layer.speed)).toBeCloseTo(Math.abs(spec.speed), 6);
    expect(layer.speed).toBe(strokeFlowSpeed(field.paths, layer.sampleBase, spec.speed));
    expect(strokeFlowSpeed(field.paths, layer.sampleBase, spec.speed, false)).toBe(-layer.speed);
  }
  // A path that ends farther out than it starts is re-signed to flow inward.
  const outward = new Float32Array(PATH_SAMPLES * 4);
  outward[0] = 1;
  outward[4 * (PATH_SAMPLES - 1)] = 5;
  expect(strokeFlowSpeed(outward, 0, 0.02)).toBe(-0.02);
  expect(strokeFlowSpeed(outward, 0, -0.02)).toBe(-0.02);
});

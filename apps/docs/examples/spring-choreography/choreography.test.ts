import { spring } from 'motion';
import { describe, expect, test } from 'vitest';

import {
  AUTO_PATTERNS,
  BURST_SPREAD,
  DEFAULT_SPRING,
  DEFAULT_STAGGER,
  LEAD,
  LOOP,
  MAX_SPRING_DURATION,
  SEGMENT,
  SHAPE_COUNT,
  SPRING_PRESETS,
  SPRING_SAMPLES,
  STAGGER_BINS,
  STAGGER_ROWS,
  activeSegments,
  arrivalCue,
  bakeSpring,
  bakeStagger,
  baseShape,
  cameraAt,
  criticallyDamped,
  cueTime,
  currentShape,
  morphWindow,
  patternFor,
  pullback,
  wrapTime,
  type SpringTable,
} from './choreography';
import swarmSource from './swarm.wgsl';

/** The swarm shader's lookup: 0 before the delay, 1 once the table has run out. */
function sampleSpring(table: SpringTable, t: number): number {
  if (t <= 0) return 0;
  if (t >= table.duration) return 1;
  const samples = table.values.length / 2;
  const f = (t / table.duration) * (samples - 1);
  const i = Math.floor(f);
  const next = Math.min(i + 1, samples - 1);
  return table.values[i * 2]! + (table.values[next * 2]! - table.values[i * 2]!) * (f - i);
}

describe('bakeSpring', () => {
  test('samples Motion’s spring from rest to rest', () => {
    const table = bakeSpring(DEFAULT_SPRING);
    const generator = spring({ keyframes: [0, 1], ...DEFAULT_SPRING });
    expect(table.values[0]).toBe(0);
    expect(table.values[1]).toBeCloseTo(0, 6);
    expect(table.values.at(-2)).toBe(1);
    expect(table.values.at(-1)).toBe(0);
    // Every sample is Motion's own value at that time.
    const samples = table.values.length / 2;
    for (const i of [64, 200, 511]) {
      const t = (i / (samples - 1)) * table.duration;
      expect(table.values[i * 2]).toBeCloseTo(generator.next(t * 1000).value, 5);
    }
  });

  test('stores velocities that integrate to the positions', () => {
    const table = bakeSpring(SPRING_PRESETS.Wobbly);
    const samples = table.values.length / 2;
    const dt = table.duration / (samples - 1);
    for (const i of [10, 100, 300, 700]) {
      const slope = (table.values[(i + 1) * 2]! - table.values[(i - 1) * 2]!) / (2 * dt);
      expect(table.values[i * 2 + 1]).toBeCloseTo(slope, 1);
    }
    expect(table.peakVelocity).toBeGreaterThan(1);
  });

  test('the bouncy default overshoots and critical damping does not', () => {
    expect(bakeSpring(DEFAULT_SPRING).overshoot).toBeGreaterThan(0.2);
    const calm = bakeSpring(criticallyDamped(DEFAULT_SPRING));
    expect(calm.overshoot).toBeLessThan(0.01);
    // Critical damping keeps the stiffness, so the morph is not slower.
    expect(calm.duration).toBeLessThan(bakeSpring(DEFAULT_SPRING).duration);
  });

  test('a spring that would ring for ages is capped and still lands on 1', () => {
    const table = bakeSpring({ stiffness: 20, damping: 1, mass: 5 });
    expect(table.duration).toBe(MAX_SPRING_DURATION);
    const samples = table.values.length / 2;
    // The windowed tail converges instead of jumping on the last sample.
    const tail = Array.from({ length: 16 }, (_, j) => table.values[(samples - 16 + j) * 2]!);
    for (const value of tail) expect(Math.abs(value - 1)).toBeLessThan(0.05);
  });
});

describe('bakeStagger', () => {
  const table = bakeStagger(DEFAULT_STAGGER.spread, DEFAULT_STAGGER.ease);
  const row = (r: number) => Array.from(table.subarray(r * STAGGER_BINS, (r + 1) * STAGGER_BINS));

  test('each row is Motion’s stagger scaled so its latest delay is the spread', () => {
    const [first, last, center, burst] = [row(0), row(1), row(2), row(3)];
    expect(Math.max(...first)).toBeCloseTo(DEFAULT_STAGGER.spread, 6);
    expect(first[0]).toBe(0);
    expect(first.every((delay, i) => i === 0 || delay >= first[i - 1]!)).toBe(true);
    // `last` mirrors `first`; `center` starts in the middle.
    expect(last[STAGGER_BINS - 1]).toBe(0);
    expect(last[0]).toBeCloseTo(DEFAULT_STAGGER.spread, 6);
    expect(Math.min(...center)).toBe(center[STAGGER_BINS / 2] ?? center[STAGGER_BINS / 2 - 1]);
    expect(center[0]).toBeCloseTo(center[STAGGER_BINS - 1]!, 2);
    // The click burst has its own fixed spread.
    expect(Math.max(...burst)).toBeCloseTo(BURST_SPREAD, 6);
  });

  test('a zero spread moves everyone at once', () => {
    const flat = bakeStagger(0, 'linear');
    expect(Array.from(flat.subarray(0, STAGGER_BINS * 3)).every((delay) => delay === 0)).toBe(true);
  });
});

describe('the timeline', () => {
  const table = bakeSpring(DEFAULT_SPRING);
  const window = morphWindow(DEFAULT_STAGGER.spread, table.duration);

  test('segments are listed oldest first, and each target is the next source', () => {
    for (let t = 0; t < LOOP; t += 0.05) {
      const active = activeSegments(t, window);
      active.forEach((segment, i) => {
        expect(segment.elapsed).toBeGreaterThanOrEqual(0);
        expect(segment.elapsed).toBeLessThan(window);
        expect(segment.target).toBe((segment.source + 1) % SHAPE_COUNT);
        if (i > 0) {
          expect(segment.elapsed).toBeLessThan(active[i - 1]!.elapsed);
          expect(segment.source).toBe(active[i - 1]!.target);
        }
      });
      if (active.length > 0) expect(baseShape(t, active)).toBe(active[0]!.source);
    }
  });

  test('the loop seam carries the last morph into the next loop', () => {
    // Before the first cue, a slow morph from the last shape into the first is still settling.
    const active = activeSegments(LEAD * 0.5, SEGMENT);
    expect(active).toEqual([
      { index: SHAPE_COUNT - 1, source: SHAPE_COUNT - 1, target: 0, elapsed: expect.closeTo(LEAD * 0.5 + SEGMENT - LEAD, 9) },
    ]);
    expect(currentShape(LEAD * 0.5)).toBe(0);
    expect(activeSegments(LEAD * 0.5 + LOOP, SEGMENT)).toEqual(active);
    expect(activeSegments(LEAD * 0.5, window)).toEqual([]);
    expect(wrapTime(-1)).toBeCloseTo(LOOP - 1, 9);
  });

  test('folding finished morphs into the base shape keeps every particle continuous', () => {
    // One coordinate per shape; delays span the whole stagger (plus its jitter).
    const shapes = [0.3, -1.2, 2.5, 0.8, -0.4];
    for (const delay of [0, DEFAULT_STAGGER.spread * 1.08]) {
      const position = (t: number) => {
        const active = activeSegments(t, window);
        let x = shapes[baseShape(t, active)]!;
        for (const segment of active) {
          x += (shapes[segment.target]! - shapes[segment.source]!) * sampleSpring(table, segment.elapsed - delay);
        }
        return x;
      };
      let previous = position(0);
      for (let t = 0.001; t <= LOOP * 1.2; t += 0.001) {
        const x = position(t);
        expect(Math.abs(x - previous)).toBeLessThan(0.05);
        previous = x;
      }
    }
  });

  test('a shape is current from the cue that morphs into it', () => {
    for (let shape = 0; shape < SHAPE_COUNT; shape++) {
      const cue = arrivalCue(shape);
      expect(currentShape(cue + 0.01)).toBe(shape);
      expect(currentShape(cue - 0.01)).toBe((shape - 1 + SHAPE_COUNT) % SHAPE_COUNT);
    }
    expect(cueTime(0)).toBe(LEAD);
  });

  test('auto gives each cue of the loop its own stagger pattern', () => {
    expect(new Set(Array.from({ length: SHAPE_COUNT }, (_, k) => patternFor('auto', k))).size).toBe(SHAPE_COUNT);
    expect(patternFor('auto', SHAPE_COUNT)).toBe(AUTO_PATTERNS[0]);
    expect(patternFor('cursor', 3)).toBe('cursor');
  });
});

describe('cameraAt', () => {
  const eyeOf = (time: number, aspect = 16 / 9, orbit = 1) => {
    const m = cameraAt(time, aspect, orbit).viewProjection;
    // Clip w is -z in view space: the fourth row is -forward, so w(origin) is the eye distance.
    return m[15]!;
  };

  test('moves continuously through every cue and across the loop seam', () => {
    let previous = cameraAt(0, 16 / 9).viewProjection;
    for (let t = 0.005; t <= LOOP + 0.5; t += 0.005) {
      const next = cameraAt(t, 16 / 9).viewProjection;
      for (let i = 0; i < 16; i++) expect(Math.abs(next[i]! - previous[i]!)).toBeLessThan(0.05);
      previous = next;
    }
  });

  test('is a pure function of the playhead', () => {
    expect(cameraAt(7.3, 1.5).viewProjection).toEqual(cameraAt(7.3 + LOOP, 1.5).viewProjection);
    expect(cameraAt(7.3, 1.5).yaw).toBe(cameraAt(7.3 + LOOP, 1.5).yaw);
  });

  test('pulls back in portrait and stops orbiting in calm mode', () => {
    expect(pullback(16 / 9)).toBe(1);
    expect(pullback(390 / 844)).toBeCloseTo(1 + (1 - 390 / 844) * 1.1, 9);
    expect(eyeOf(3, 390 / 844)).toBeCloseTo(eyeOf(3) * pullback(390 / 844), 4);
    // Without the orbit only the per-shape poses turn the camera, a fraction of a radian.
    for (let t = 0; t < LOOP; t += 0.25) expect(Math.abs(cameraAt(t, 1, 0).yaw)).toBeLessThan(0.6);
    expect(cameraAt(LOOP / 2, 1, 1).yaw - cameraAt(LOOP / 2, 1, 0).yaw).toBeCloseTo(Math.PI, 9);
  });
});

test('swarm.wgsl mirrors the timeline length and the table layout', () => {
  // The shader loader prefixes module-level names.
  const constant = (name: string) => Number(swarmSource.wgsl.match(new RegExp(`const (?:\\w+__)?${name} = ([\\d.]+)u?;`))?.[1]);
  expect(constant('LOOP')).toBe(LOOP);
  expect(constant('SPRING_SAMPLES')).toBe(SPRING_SAMPLES);
  // Value and velocity per spring sample, then the stagger rows.
  expect(constant('STAGGER_BASE')).toBe(SPRING_SAMPLES * 2);
  expect(constant('STAGGER_BINS')).toBe(STAGGER_BINS);
  expect(constant('BURST_ROW')).toBe(STAGGER_ROWS.indexOf('burst'));
});

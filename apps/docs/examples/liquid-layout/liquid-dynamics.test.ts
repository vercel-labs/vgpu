import { describe, expect, test } from 'vitest';

import fieldSource from './field.wgsl';
import { cornerRadius } from './layout-store';
import {
  createDynamics,
  K_DRAG,
  K_REST,
  MAX_PRIMS,
  PRIM_FLOATS,
  type CardSample,
  type LiquidFrame,
} from './liquid-dynamics';

const VIEWPORT = [1280, 720] as const;
const DT = 1 / 60;
// The corner of the default 200 × 240 sample card.
const CORNER = cornerRadius(200, 240);

function sample(overrides: Partial<CardSample> & { id: string }): CardSample {
  return {
    layer: 'grid',
    cx: 400,
    cy: 300,
    hw: 100,
    hh: 120,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    hue: 0,
    present: true,
    hovered: false,
    lifted: false,
    ...overrides,
  };
}

// Decodes the primitive array; see field.wgsl for the layout.
function prims(frame: LiquidFrame) {
  return Array.from({ length: frame.count }, (_, i) => {
    const p = frame.data.subarray(i * PRIM_FLOATS, (i + 1) * PRIM_FLOATS);
    return {
      type: p[6]!,
      cx: p[0]!,
      cy: p[1]!,
      hw: p[2]!,
      hh: p[3]!,
      corner: p[4]!,
      k: p[5]!,
      hue: p[7]!,
      matrix: [p[8]!, p[9]!, p[10]!, p[11]!],
      erode: p[12]!,
      energy: p[13]!,
      distScale: p[14]!,
      wobble: p[15]!,
    };
  });
}

/** field.wgsl packs the wobble as phase * 16 + amplitude. */
const wobbleAmplitude = (code: number) => code - Math.floor(code / 16) * 16;

function expectUnstrained(matrix: readonly number[], digits = 6) {
  matrix.forEach((value, i) => expect(value).toBeCloseTo(i === 0 || i === 3 ? 1 : 0, digits));
}

function run(dynamics: ReturnType<typeof createDynamics>, seconds: number, samples: (i: number) => CardSample[]) {
  let frame: LiquidFrame | undefined;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) frame = dynamics.update(samples(i), DT, VIEWPORT);
  return frame!;
}

const dynamics = (reducedMotion = false) => createDynamics({ smoothness: 1, reducedMotion });

describe('card bodies', () => {
  test('a resting card settles into one rounded grid rect at the rest radius', () => {
    const liquid = dynamics();
    const frame = run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    const [body, ...rest] = prims(frame);
    expect(rest).toHaveLength(0);
    expect(body).toMatchObject({ type: 0, cx: 400, cy: 300, hw: 100, hh: 120, corner: CORNER, k: K_REST, hue: 1 });
    expectUnstrained(body!.matrix, 3);
    expect(body!.energy).toBeLessThan(0.01);
  });

  test('new cards open out of their centres as circles, one after another in reading order', () => {
    const liquid = dynamics();
    const cards = [sample({ id: 'b', cx: 700 }), sample({ id: 'a', cx: 400 })];
    // The first card in reading order starts as a small circle at its centre.
    const [first, ...others] = prims(liquid.update(cards, DT, VIEWPORT));
    expect(others).toHaveLength(0);
    expect(first).toMatchObject({ type: 0, cx: 400, cy: 300 });
    expect(first!.hw).toBeLessThan(10);
    expect(first!.hh).toBe(first!.hw);
    expect(first!.corner).toBe(first!.hw);
    // Both grow as circles, the second a step behind the first.
    const growing = prims(run(liquid, 0.1, () => cards));
    expect(growing.map((prim) => [prim.type, prim.cx])).toEqual([
      [0, 700],
      [0, 400],
    ]);
    const [late, early] = growing;
    expect(early!.hw).toBeGreaterThan(late!.hw);
    for (const circle of growing) {
      expect(circle.hh).toBe(circle.hw);
      expect(circle.corner).toBe(circle.hw);
    }
    // Then each squares off into its card.
    const settled = prims(run(liquid, 2, () => cards));
    expect(settled.map((prim) => [prim.type, prim.hw, prim.hh, prim.corner])).toEqual([
      [0, 100, 120, CORNER],
      [0, 100, 120, CORNER],
    ]);
  });

  test('a resting card is an exact rounded rect: no wobble', () => {
    const liquid = dynamics();
    const [body] = prims(run(liquid, 2, () => [sample({ id: 'a' })]));
    expect(wobbleAmplitude(body!.wobble)).toBe(0);
  });

  test('fast cards melt: their radius reaches for neighbours and their corners round', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hw: 130, hh: 130 })]);
    const frame = run(liquid, 0.25, (i) => [sample({ id: 'a', hw: 130, hh: 130, cx: 400 + 30 * (i + 1) })]);
    const [body] = prims(frame);
    expect(body!.k).toBeGreaterThan(K_REST + 20);
    expect(body!.corner).toBeGreaterThan(cornerRadius(260, 260) * 1.5);
    // Melting calms the wobble.
    expect(wobbleAmplitude(body!.wobble)).toBeLessThan(6.5);
    expect(body!.hw).toBeLessThan(130);
    // Stretched along the motion: the world → local matrix shrinks x.
    expect(body!.matrix[0]).toBeLessThan(0.95);
    expect(body!.energy).toBeGreaterThan(0.5);
  });

  test('small cards reach less far than large ones at the same speed', () => {
    const liquid = dynamics();
    const cards = (x: number) => [
      sample({ id: 'large', hw: 130, hh: 130, cx: 300 + x }),
      sample({ id: 'small', hw: 40, hh: 40, cx: 300 + x, cy: 600 }),
    ];
    run(liquid, 2, () => cards(0));
    const [large, small] = prims(run(liquid, 0.25, (i) => cards(30 * (i + 1))));
    expect(small!.k).toBeLessThan(large!.k * 0.6);
    expect(small!.k).toBeGreaterThan(K_REST);
  });

  test('a teleport (a resize) moves a card without melting it', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    const [body] = prims(liquid.update([sample({ id: 'a', cx: 900 })], DT, VIEWPORT, true));
    expect(body).toMatchObject({ cx: 900, k: K_REST, corner: CORNER });
  });

  test('smoothness scales every merge radius', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    liquid.setOptions({ smoothness: 2 });
    expect(prims(liquid.update([sample({ id: 'a' })], DT, VIEWPORT))[0]!.k).toBe(K_REST * 2);
  });

  test('never emits more primitives than the field holds', () => {
    const liquid = dynamics();
    const cards = Array.from({ length: 40 }, (_, i) =>
      sample({ id: `card-${i}`, cx: 40 + (i % 10) * 120, cy: 60 + Math.floor(i / 10) * 160, hw: 50, hh: 60 }),
    );
    const frame = run(liquid, 3, () => cards);
    expect(frame.count).toBe(MAX_PRIMS);
    expect(frame.data).toHaveLength(MAX_PRIMS * PRIM_FLOATS);
  });
});

describe('leaving cards', () => {
  test('a removed card closes into its centre as a circle, the entry in reverse', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    // The card is gone, its glass is not: the body starts closing in place.
    const [first, ...others] = prims(liquid.update([], DT, VIEWPORT));
    expect(others).toHaveLength(0);
    expect(first).toMatchObject({ type: 0, cx: 400, cy: 300, hw: 100, hh: 120, hue: 1 });
    expect(first!.corner).toBeGreaterThan(CORNER);
    // The corners round off, then a circle shrinks into the centre.
    const [closing] = prims(run(liquid, 0.3, () => []));
    expect(closing).toMatchObject({ type: 0, cx: 400, cy: 300 });
    expect(closing!.hw).toBeLessThan(60);
    expect(closing!.hh).toBe(closing!.hw);
    expect(closing!.corner).toBe(closing!.hw);
    expect(run(liquid, 0.3, () => []).count).toBe(0);
  });

  test('a card removed before it grew leaves nothing behind', () => {
    const liquid = dynamics();
    liquid.update([sample({ id: 'a' })], DT, VIEWPORT);
    expect(liquid.update([], DT, VIEWPORT).count).toBe(0);
  });
});

describe('the top layer', () => {
  test('a lifted card cross-fades between the layers instead of popping', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    const lifting = liquid.update([sample({ id: 'a', lifted: true })], DT, VIEWPORT);
    expect(prims(lifting).map((prim) => prim.type)).toEqual([0, 2]);
    expect(lifting.panelLift).toBeGreaterThan(0);
    expect(lifting.panelLift).toBeLessThan(1);
    const lifted = run(liquid, 0.5, () => [sample({ id: 'a', lifted: true })]);
    expect(prims(lifted).map((prim) => prim.type)).toEqual([2]);
    expect(lifted.panelLift).toBe(1);
    const landed = run(liquid, 0.5, () => [sample({ id: 'a' })]);
    expect(prims(landed).map((prim) => prim.type)).toEqual([0]);
    expect(landed.panelLift).toBe(0);
  });

  test('the open panel is a panel-layer rect with the larger corner and no wobble', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })]);
    const frame = liquid.update([sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })], DT, VIEWPORT);
    const [panel] = prims(frame);
    expect(panel).toMatchObject({ type: 2, corner: cornerRadius(600, 400) });
    expect(wobbleAmplitude(panel!.wobble)).toBe(0);
  });
});

describe('dragging', () => {
  const held = (i: number) => {
    const offset = Math.min(150, 10 * (i + 1));
    return [sample({ id: 'a', hue: 1, cx: 400 + offset, offsetX: offset, scale: 1.06, hw: 106, hh: 127.2 })];
  };

  test('a dragged card stays one grid body with the wide drag radius', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    const frame = run(liquid, 0.6, held);
    const [body, ...rest] = prims(frame);
    expect(rest).toHaveLength(0);
    expect(body).toMatchObject({ type: 0, hue: 1 });
    expect(body!.cx).toBeCloseTo(550, 2);
    expect(body!.k).toBeGreaterThanOrEqual(K_DRAG);
    // It keeps most of its shape: the copy is still on it.
    expect(body!.hw).toBeGreaterThan(100);
    expect(frame.panelLift).toBe(0);
  });

  test('a dragged card fuses with the cards it crosses in the same field', () => {
    const liquid = dynamics();
    const other = sample({ id: 'b', cx: 800 });
    run(liquid, 2, () => [sample({ id: 'a' }), other]);
    const frame = run(liquid, 0.6, (i) => [
      sample({ id: 'a', cx: 400 + Math.min(300, 20 * (i + 1)), offsetX: Math.min(300, 20 * (i + 1)) }),
      other,
    ]);
    const [dragged, resting] = prims(frame);
    expect([dragged!.type, resting!.type]).toEqual([0, 0]);
    // The field blends each pair with the larger radius, so the neighbour meets the drag radius.
    expect(Math.max(dragged!.k, resting!.k)).toBeGreaterThanOrEqual(K_DRAG);
    expect(resting!.k).toBe(K_REST);
  });
});

test('the shaders size their uniform arrays to the dynamics buffers', () => {
  const arrays = (source: { wgsl: string }) => [...source.wgsl.matchAll(/array<vec4f, (\d+)>/g)].map((match) => Number(match[1]));
  expect(arrays(fieldSource)).toEqual([(MAX_PRIMS * PRIM_FLOATS) / 4]);
  expect(Number(fieldSource.wgsl.match(/const (?:\w+__)?MAX_PRIMS = (\d+)u;/)?.[1])).toBe(MAX_PRIMS);
});

describe('reduced motion', () => {
  test('cards fade in and out in place and never stretch or melt', () => {
    const liquid = dynamics(true);
    const [entering] = prims(liquid.update([sample({ id: 'a' })], DT, VIEWPORT));
    expect(entering).toMatchObject({ type: 0, cx: 400, cy: 300 });
    expect(entering!.erode).toBeGreaterThan(0);

    run(liquid, 1, () => [sample({ id: 'a' })]);
    const [moving] = prims(run(liquid, 0.25, (i) => [sample({ id: 'a', cx: 400 + 30 * (i + 1) })]));
    expect(moving!.k).toBe(K_REST);
    expectUnstrained(moving!.matrix);
    expect(moving!.hw).toBe(100);

    // A removed card fades where it stood instead of closing into its centre.
    expect(prims(liquid.update([], DT, VIEWPORT)).map((prim) => [prim.type, prim.cy])).toEqual([[0, 300]]);
    expect(prims(run(liquid, 0.25, () => [])).map((prim) => [prim.type, prim.cy])).toEqual([[0, 300]]);
    expect(run(liquid, 0.3, () => []).count).toBe(0);
  });

  test('switching mid-flight calms a moving card at once', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    run(liquid, 0.2, (i) => [sample({ id: 'a', cx: 400 + 30 * (i + 1) })]);
    liquid.setOptions({ reducedMotion: true });
    const [body] = prims(liquid.update([sample({ id: 'a', cx: 1000 })], DT, VIEWPORT));
    expect(body!.k).toBe(K_REST);
    expectUnstrained(body!.matrix);
  });
});

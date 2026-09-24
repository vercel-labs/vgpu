import { describe, expect, test } from 'vitest';

import {
  CORNER,
  createDynamics,
  K_REST,
  MAX_PRIMS,
  PRIM_FLOATS,
  type CardSample,
  type LiquidFrame,
} from './liquid-dynamics';

const VIEWPORT = [1280, 720] as const;
const DT = 1 / 60;

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
    };
  });
}

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
    expect(frame.activity).toBeLessThan(0.01);
  });

  test('new cards fall in as droplets, one after another in reading order', () => {
    const liquid = dynamics();
    const cards = [sample({ id: 'b', cx: 700 }), sample({ id: 'a', cx: 400 })];
    const first = prims(liquid.update(cards, DT, VIEWPORT));
    expect(first).toHaveLength(1);
    expect(first[0]!.type).toBe(1);
    // The capsule starts above the card and falls towards it.
    expect(first[0]!.cx).toBe(400);
    expect(first[0]!.cy).toBeLessThan(300 - 120);
    const later = prims(run(liquid, 0.1, () => cards));
    expect(later.filter((prim) => prim.type === 1)).toHaveLength(2);
    // After the fall each droplet grows into its card, then only the bodies remain.
    const landed = prims(run(liquid, 2, () => cards));
    expect(landed.map((prim) => prim.type)).toEqual([0, 0]);
  });

  test('fast cards melt: their radius reaches for neighbours and their corners round', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hw: 130, hh: 130 })]);
    const frame = run(liquid, 0.25, (i) => [sample({ id: 'a', hw: 130, hh: 130, cx: 400 + 30 * (i + 1) })]);
    const [body] = prims(frame);
    expect(body!.k).toBeGreaterThan(K_REST + 30);
    expect(body!.corner).toBeGreaterThan(CORNER * 2);
    expect(body!.hw).toBeLessThan(130);
    // Stretched along the motion: the world → local matrix shrinks x.
    expect(body!.matrix[0]).toBeLessThan(0.95);
    expect(frame.activity).toBeGreaterThan(0.5);
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
  test('a removed card drains into a falling drop that finishes offscreen', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    const first = liquid.update([], DT, VIEWPORT);
    expect(liquid.blobCount).toBe(0);
    expect(liquid.dripCount).toBe(1);
    expect(prims(first).map((prim) => [prim.type, prim.hue])).toEqual([[0, 1]]);
    // The drop grows at the bottom edge, then lets go.
    const hanging = run(liquid, 0.4, () => []);
    expect(prims(hanging).map((prim) => [prim.type, prim.hue])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(liquid.dripCount).toBe(1);
    run(liquid, 2.5, () => []);
    expect(liquid.dripCount).toBe(0);
    expect(liquid.update([], DT, VIEWPORT).count).toBe(0);
  });

  test('a card removed before it grew leaves nothing behind', () => {
    const liquid = dynamics();
    liquid.update([sample({ id: 'a' })], DT, VIEWPORT);
    liquid.update([], DT, VIEWPORT);
    expect(liquid.dripCount).toBe(0);
  });
});

describe('the top layer', () => {
  test('a dragged card lifts off a puddle joined to its slot by a tether', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    const held = (i: number) => {
      const offset = Math.min(150, 10 * (i + 1));
      return [sample({ id: 'a', hue: 1, cx: 400 + offset, offsetX: offset, scale: 1.06, hw: 106, hh: 127.2 })];
    };
    const frame = run(liquid, 0.6, held);
    const [puddle, rope, rope2, body, ...rest] = prims(frame);
    expect(rest).toHaveLength(0);
    // The puddle stays in the slot; the rope runs from it to the card.
    expect(puddle).toMatchObject({ type: 0, cx: 400, cy: 300 });
    expect(puddle!.hw).toBeLessThan(100);
    expect(rope!.type).toBe(1);
    expect(rope2!.type).toBe(1);
    expect(rope!.cx).toBe(400);
    expect(body).toMatchObject({ type: 2, hue: 1 });
    expect(frame.panelLift).toBe(1);
    expect(frame.panelHue).toBe(1);
  });

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

  test('the open panel is a panel-layer rect with the larger corner', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })]);
    const [panel] = prims(liquid.update([sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })], DT, VIEWPORT));
    expect(panel).toMatchObject({ type: 2, corner: 30 });
  });
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

    liquid.update([], DT, VIEWPORT);
    expect(liquid.dripCount).toBe(1);
    run(liquid, 0.5, () => []);
    expect(liquid.dripCount).toBe(0);
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

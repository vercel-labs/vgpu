import { describe, expect, test } from 'vitest';

import bubblesSource from './bubbles.wgsl';
import fieldSource from './field.wgsl';
import { cornerRadius } from './layout-store';
import {
  BUBBLE_FLOATS,
  createDynamics,
  K_DRAG,
  K_REST,
  MAX_BUBBLES,
  MAX_NECKS,
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

/**
 * Necks (bars: centre in cx/cy, half length in hw, fillet radius in hh, waist
 * in corner) and their droplets (point segments whose radius rides in erode,
 * negative = above the surface).
 */
const necksOf = (frame: LiquidFrame) => prims(frame).filter((prim) => prim.type === 8 || prim.type === 5);

function bubblesOf(frame: LiquidFrame) {
  return Array.from({ length: frame.bubbleCount }, (_, i) => {
    const b = frame.bubbles.subarray(i * BUBBLE_FLOATS, (i + 1) * BUBBLE_FLOATS);
    return { x: b[0]!, y: b[1]!, radius: b[2]!, alpha: b[3]! };
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

  test('a resting card bulges by a size-scaled wobble with a stable phase', () => {
    const liquid = dynamics();
    const [body] = prims(run(liquid, 2, () => [sample({ id: 'a' })]));
    // 6.5 px on a 120 px half-size card, scaled by the short half-size.
    expect(wobbleAmplitude(body!.wobble)).toBeCloseTo(6.5 * (100 / 120), 3);
    const phase = Math.floor(body!.wobble / 16);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(64);
    const [again] = prims(run(dynamics(), 2, () => [sample({ id: 'a' })]));
    expect(again!.wobble).toBe(body!.wobble);
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
  test('a removed card drains into a falling drop that finishes offscreen', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', hue: 1 })]);
    // The card is gone, its liquid is not: the body drains in place.
    const first = liquid.update([], DT, VIEWPORT);
    expect(prims(first).map((prim) => [prim.type, prim.hue])).toEqual([[0, 1]]);
    // The drop grows at the bottom edge, then lets go.
    const hanging = run(liquid, 0.4, () => []);
    expect(prims(hanging).map((prim) => [prim.type, prim.hue])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(run(liquid, 2.5, () => []).count).toBe(0);
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

  test('the open panel is a panel-layer rect with the larger corner and its own wobble', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })]);
    const frame = liquid.update([sample({ id: 'a', layer: 'panel', lifted: true, hw: 300, hh: 200 })], DT, VIEWPORT);
    const [panel] = prims(frame);
    expect(panel).toMatchObject({ type: 2, corner: 32 });
    expect(wobbleAmplitude(panel!.wobble)).toBeCloseTo(7, 3);
    // The panel's bubbles ride on the top layer.
    expect(bubblesOf(frame).length).toBeGreaterThan(0);
    expect(bubblesOf(frame).every((bubble) => bubble.alpha < 0)).toBe(true);
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

describe('necks', () => {
  // Two row neighbours 25 px apart.
  const pair = (bx = 625, by = 300) => [sample({ id: 'a' }), sample({ id: 'b', cx: bx, cy: by, hue: 1 })];

  test('grow at mid-height between resting row neighbours, rising from the edges', () => {
    const liquid = dynamics();
    // Rested apart, then brought within reach (a resize): the neck starts that frame.
    run(liquid, 2, () => pair(725));
    expect(necksOf(run(liquid, DT, () => pair(725)))).toHaveLength(0);
    const [forming] = necksOf(liquid.update(pair(), DT, VIEWPORT, true));
    // A fresh neck is parted: a waist of about -fillet leaves the surface as it was.
    expect(forming!.type).toBe(8);
    expect(forming!.corner).toBeLessThan(-0.9 * forming!.hh);

    const necks = necksOf(run(liquid, 1.5, () => pair()));
    const [neck] = necks.filter((prim) => prim.type === 8);
    expect(neck).toBeDefined();
    // It is centred in the gap and reaches a little inside each card.
    expect(neck!.cx).toBeCloseTo(512.5, 6);
    expect(neck!.hw).toBeGreaterThan(12.5 + 4);
    expect(neck!.cy).toBeGreaterThan(180 + 240 * 0.3);
    expect(neck!.cy).toBeLessThan(180 + 240 * 0.6);
    // Full grown it is a waist a few px thick whose fillets leave a short
    // straight stretch in the gap, tinted between the two cards.
    expect(neck!.corner).toBeGreaterThan(2);
    expect(neck!.corner).toBeLessThan(5);
    expect(neck!.hh).toBeGreaterThan(neck!.corner);
    expect(neck!.hh).toBeLessThan(12.5);
    expect(neck!.hue).toBeCloseTo(0.5, 6);
    // A droplet on it, if any, blends with its own radius.
    for (const bead of necks.filter((prim) => prim.type === 5)) {
      expect(bead.cx).toBeGreaterThan(500);
      expect(bead.cx).toBeLessThan(525);
    }
  });

  test('pinch apart as soon as either card moves', () => {
    const liquid = dynamics();
    run(liquid, 2, () => pair());
    expect(necksOf(run(liquid, DT, () => pair())).length).toBeGreaterThan(0);
    // Sliding slowly down keeps the pair in range but no longer resting.
    const frame = run(liquid, 0.3, (i) => pair(625, 300 + 1.5 * (i + 1)));
    expect(necksOf(frame)).toHaveLength(0);
  });

  test('never form across a wide gap or between rows', () => {
    const wide = dynamics();
    expect(necksOf(run(wide, 2, () => pair(700)))).toHaveLength(0);
    const rows = dynamics();
    expect(necksOf(run(rows, 2, () => pair(625, 560)))).toHaveLength(0);
  });

  test('a row of cards grows at most MAX_NECKS necks and no card joins two', () => {
    const liquid = dynamics();
    const row = Array.from({ length: 5 }, (_, i) => sample({ id: `card-${i}`, cx: 150 + 225 * i }));
    const frame = run(liquid, 2, () => row);
    const necks = necksOf(frame).filter((prim) => prim.type === 8);
    expect(necks.length).toBeGreaterThan(0);
    expect(necks.length).toBeLessThanOrEqual(MAX_NECKS);
    const gaps = necks.map((neck) => Math.round((neck.cx - 262.5) / 225));
    expect(new Set(gaps).size).toBe(gaps.length);
    gaps.forEach((gap, i) => gaps.slice(i + 1).forEach((other) => expect(Math.abs(gap - other)).toBeGreaterThan(1)));
  });
});

describe('bubbles', () => {
  test('a resting card carries a few small bubbles inside its rim', () => {
    const liquid = dynamics();
    const bubbles = bubblesOf(run(liquid, 2, () => [sample({ id: 'a' })]));
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    for (const bubble of bubbles) {
      // 3 to 10 px across.
      expect(bubble.radius).toBeGreaterThanOrEqual(1.4);
      expect(bubble.radius).toBeLessThanOrEqual(5);
      expect(Math.abs(bubble.x - 400)).toBeLessThan(100 - bubble.radius);
      expect(Math.abs(bubble.y - 300)).toBeLessThan(120 - bubble.radius);
      expect(bubble.alpha).toBeCloseTo(1, 2);
    }
  });

  test('drift slowly, deterministically per card', () => {
    const first = bubblesOf(run(dynamics(), 2, () => [sample({ id: 'a' })]));
    const second = bubblesOf(run(dynamics(), 2, () => [sample({ id: 'a' })]));
    expect(second).toEqual(first);
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    const later = bubblesOf(run(liquid, 1, () => [sample({ id: 'a' })]));
    later.forEach((bubble, i) => expect(Math.hypot(bubble.x - first[i]!.x, bubble.y - first[i]!.y)).toBeLessThan(4.5));
  });

  test('fade while the card moves fast', () => {
    const liquid = dynamics();
    run(liquid, 2, () => [sample({ id: 'a' })]);
    const moving = bubblesOf(run(liquid, 0.25, (i) => [sample({ id: 'a', cx: 400 + 30 * (i + 1) })]));
    expect(moving.every((bubble) => bubble.alpha < 0.5)).toBe(true);
  });

  test('never exceed the uniform array', () => {
    const liquid = dynamics();
    const cards = Array.from({ length: 16 }, (_, i) =>
      sample({ id: `card-${i}`, cx: 40 + (i % 8) * 150, cy: 100 + Math.floor(i / 8) * 300, hw: 60, hh: 100 }),
    );
    const frame = run(liquid, 2, () => cards);
    expect(frame.bubbleCount).toBe(MAX_BUBBLES);
    expect(frame.bubbles).toHaveLength(MAX_BUBBLES * BUBBLE_FLOATS);
  });
});

test('the shaders size their uniform arrays to the dynamics buffers', () => {
  const arrays = (source: { wgsl: string }) => [...source.wgsl.matchAll(/array<vec4f, (\d+)>/g)].map((match) => Number(match[1]));
  expect(arrays(fieldSource)).toEqual([(MAX_PRIMS * PRIM_FLOATS) / 4]);
  expect(Number(fieldSource.wgsl.match(/const (?:\w+__)?MAX_PRIMS = (\d+)u;/)?.[1])).toBe(MAX_PRIMS);
  expect(arrays(bubblesSource)).toEqual([(MAX_BUBBLES * BUBBLE_FLOATS) / 4]);
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

    // A removed card fades where it stood: no drop forms and nothing falls.
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

import { describe, expect, test, vi } from 'vitest';

import { CARDS, CARD_BY_ID } from './cards';
import {
  cornerRadius,
  createLayoutStore,
  createRandom,
  DEFAULT_SPRING,
  gridFrame,
  gridLayout,
  isArrowKey,
  keyedIndex,
  shuffled,
  slotAt,
  type CardHandle,
} from './layout-store';

const ids = CARDS.map((card) => card.id);
const library = (id: string) => CARD_BY_ID.get(id)?.library;

function fixedPoints(before: readonly string[], after: readonly string[]) {
  return after.filter((id, i) => before[i] === id).length;
}

function handle(id: string): CardHandle {
  const value = { get: () => 0 };
  return { id, layer: 'grid', element: null, x: value, y: value, scale: value, rotate: value, present: true, hovered: false };
}

describe('layout store', () => {
  test('starts with every card in reading order and the default layout spring', () => {
    expect(createLayoutStore().getState()).toEqual({
      order: ids,
      filter: 'all',
      expanded: null,
      openedBy: null,
      returning: null,
      ...DEFAULT_SPRING,
    });
  });

  test('shuffles deterministically per seed and moves all but at most one card', () => {
    const a = createLayoutStore();
    const b = createLayoutStore();
    for (let i = 0; i < 40; i++) {
      const before = a.getState().order;
      a.shuffle();
      b.shuffle();
      expect(a.getState().order).toEqual(b.getState().order);
      expect([...a.getState().order].sort()).toEqual([...ids].sort());
      expect(fixedPoints(before, a.getState().order)).toBeLessThanOrEqual(1);
    }
  });

  test('shuffled keeps the items and falls back to the best attempt', () => {
    expect(shuffled([], createRandom(1))).toEqual([]);
    expect(shuffled(['a'], createRandom(1))).toEqual(['a']);
    expect(shuffled(['a', 'b'], createRandom(1))).toEqual(['b', 'a']);
  });

  test('a filtered shuffle permutes the visible cards among their own slots', () => {
    const store = createLayoutStore();
    store.setFilter('vgpu');
    const before = store.getState().order;
    store.shuffle();
    const after = store.getState().order;
    after.forEach((id, i) => {
      if (library(before[i]!) === 'motion') expect(id).toBe(before[i]);
      else expect(library(id)).toBe('vgpu');
    });
    expect(after).not.toEqual(before);
  });

  test('notifies subscribers on change only', () => {
    const store = createLayoutStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.shuffle();
    expect(listener).toHaveBeenCalledTimes(1);
    store.setFilter('all');
    store.setSpring({ ...DEFAULT_SPRING });
    store.collapse();
    store.settle('surface');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.shuffle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('filtering hides cards and closes a hidden panel', () => {
    const store = createLayoutStore();
    store.expand('drag', 'auto');
    store.setFilter('motion');
    expect(store.getState()).toMatchObject({ filter: 'motion', expanded: 'drag', openedBy: 'auto' });
    expect(store.visible().every((id) => library(id) === 'motion')).toBe(true);
    store.setFilter('vgpu');
    expect(store.getState()).toMatchObject({ filter: 'vgpu', expanded: null, openedBy: null });
    expect(store.visible()).toHaveLength(4);

    store.expand('frame');
    store.collapse();
    expect(store.getState().returning).toBe('frame');
    store.setFilter('motion');
    expect(store.getState().returning).toBeNull();
  });

  test('expand, collapse and settle track the open and the returning card', () => {
    const store = createLayoutStore();
    store.expand('layout');
    expect(store.getState()).toMatchObject({ expanded: 'layout', openedBy: 'user', returning: null });
    store.collapse();
    expect(store.getState()).toMatchObject({ expanded: null, openedBy: null, returning: 'layout' });
    // Opening another card while one flies back hands the top layer over.
    store.expand('effect', 'auto');
    expect(store.getState()).toMatchObject({ expanded: 'effect', openedBy: 'auto', returning: null });
    store.collapse();
    store.settle('layout');
    expect(store.getState().returning).toBe('effect');
    store.settle('effect');
    expect(store.getState().returning).toBeNull();

    store.setFilter('vgpu');
    const state = store.getState();
    store.expand('drag');
    expect(store.getState()).toBe(state);
  });

  test('re-expanding the open card changes nothing', () => {
    const store = createLayoutStore();
    store.expand('layout');
    const state = store.getState();
    store.expand('layout', 'auto');
    expect(store.getState()).toBe(state);
  });

  test('setSpring accepts partial updates', () => {
    const store = createLayoutStore();
    store.setSpring({ stiffness: 300 });
    expect(store.getState()).toMatchObject({ stiffness: 300, damping: DEFAULT_SPRING.damping });
    store.setSpring({ damping: 30 });
    expect(store.getState()).toMatchObject({ stiffness: 300, damping: 30 });
  });

  test('move reorders the visible cards and reports whether anything changed', () => {
    const store = createLayoutStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.move('surface', 2)).toBe(true);
    expect(store.getState().order.slice(0, 4)).toEqual(['effect', 'target', 'surface', 'frame']);
    // Out-of-range indices clamp; staying put or an unknown card changes nothing.
    expect(store.move('surface', 99)).toBe(true);
    expect(store.getState().order.at(-1)).toBe('surface');
    expect(store.move('surface', 7)).toBe(false);
    expect(store.move('missing', 0)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('a filtered move keeps the hidden cards in their places', () => {
    const store = createLayoutStore();
    store.setFilter('motion');
    // Visible: layout, layoutId, drag, presence.
    expect(store.move('presence', 0)).toBe(true);
    expect(store.visible()).toEqual(['presence', 'layout', 'layoutId', 'drag']);
    expect(store.getState().order.slice(0, 4)).toEqual(['surface', 'effect', 'target', 'frame']);
  });

  test('a stale unregister keeps the handle that replaced it', () => {
    const store = createLayoutStore();
    const first = handle('drag');
    const second = handle('drag');
    const unregisterFirst = store.register(first);
    const unregisterSecond = store.register(second);
    unregisterFirst();
    expect([...store.handles()]).toEqual([second]);
    unregisterSecond();
    expect([...store.handles()]).toEqual([]);
  });
});

describe('gridLayout', () => {
  const fits = (width: number, height: number, count: number) => {
    const layout = gridLayout(width, height, count);
    expect(layout.width).toBeLessThanOrEqual(width);
    expect(layout.height).toBeLessThanOrEqual(height);
    expect(layout.cardWidth / layout.cardHeight).toBeGreaterThanOrEqual(0.98);
    expect(layout.cardWidth / layout.cardHeight).toBeLessThanOrEqual(1.3 + 1 / layout.cardHeight);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count);
    return layout;
  };

  test('landscape frames get four columns of slightly wide cards', () => {
    expect(fits(1192, 584, 8)).toMatchObject({ columns: 4, rows: 2, cardWidth: 279, cardHeight: 232, gap: 25 });
    expect(fits(744, 332, 8)).toMatchObject({ columns: 4, rows: 2 });
  });

  test('portrait frames and short lists get two', () => {
    expect(fits(358, 712, 8)).toMatchObject({ columns: 2, rows: 4 });
    expect(fits(1192, 584, 4)).toMatchObject({ columns: 2, rows: 2 });
    expect(fits(1192, 584, 1)).toMatchObject({ columns: 1, rows: 1 });
  });

  test('keeps a square to slightly wide card in every frame', () => {
    for (const [width, height] of [
      [2400, 300],
      [300, 2400],
      [1600, 900],
      [900, 900],
      [500, 400],
    ] as const) {
      for (const count of [2, 4, 8]) fits(width, height, count);
    }
  });
});

describe('gridFrame', () => {
  test.each([
    [1280, 720, 8],
    [832, 468, 8],
    [390, 844, 8],
    [832, 468, 4],
  ] as const)('%i×%i with %i cards sits below the GUI bar inside the padding', (width, height, count) => {
    const frame = gridFrame(width, height, count);
    const padX = width < 560 ? 14 : 20;
    expect(frame.left).toBeGreaterThanOrEqual(padX);
    expect(frame.left + frame.width).toBeLessThanOrEqual(width - padX);
    // Room for the closed lil-gui bar above (and the first row's bulge on a
    // phone, where the bar spans it), centred vertically when it fits.
    expect(frame.top).toBeGreaterThanOrEqual(width < 560 ? 62 : 52);
    expect(frame.top + frame.height).toBeLessThanOrEqual(height - 16);
    expect(Math.abs(frame.left - (width - frame.width - frame.left))).toBeLessThanOrEqual(1);
  });

  test('a phone gets two columns', () => {
    expect(gridFrame(390, 844, 8)).toMatchObject({ columns: 2, rows: 4 });
  });
});

describe('cornerRadius', () => {
  test('scales with the short side between 18 and 32 px', () => {
    expect(cornerRadius(279, 232)).toBe(30);
    expect(cornerRadius(100, 80)).toBe(18);
    expect(cornerRadius(600, 400)).toBe(32);
  });
});

describe('keyedIndex', () => {
  test('left and right step through reading order across rows', () => {
    expect(keyedIndex('ArrowRight', 0, 8, 4)).toBe(1);
    expect(keyedIndex('ArrowRight', 3, 8, 4)).toBe(4);
    expect(keyedIndex('ArrowLeft', 4, 8, 4)).toBe(3);
  });

  test('up and down keep the column', () => {
    expect(keyedIndex('ArrowDown', 1, 8, 4)).toBe(5);
    expect(keyedIndex('ArrowUp', 6, 8, 4)).toBe(2);
    expect(keyedIndex('ArrowDown', 0, 8, 2)).toBe(2);
  });

  test('the grid edges, a short last row and other keys go nowhere', () => {
    expect(keyedIndex('ArrowLeft', 0, 8, 4)).toBeNull();
    expect(keyedIndex('ArrowRight', 7, 8, 4)).toBeNull();
    expect(keyedIndex('ArrowUp', 2, 8, 4)).toBeNull();
    expect(keyedIndex('ArrowDown', 5, 8, 4)).toBeNull();
    // Six cards in four columns: nothing sits below the third or fourth card.
    expect(keyedIndex('ArrowDown', 2, 6, 4)).toBeNull();
    expect(keyedIndex('ArrowDown', 1, 6, 4)).toBe(5);
    expect(keyedIndex('Enter', 0, 8, 4)).toBeNull();
    expect(keyedIndex('ArrowRight', -1, 8, 4)).toBeNull();
  });

  test('isArrowKey recognises exactly the four arrows', () => {
    expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].every(isArrowKey)).toBe(true);
    expect(['Enter', 'Home', 'toString', ' '].some(isArrowKey)).toBe(false);
  });
});

describe('slotAt', () => {
  const layout = gridLayout(1192, 584, 8);
  const pitchX = layout.cardWidth + layout.gap;
  const pitchY = layout.cardHeight + layout.gap;

  test('maps a point to the visible index of the slot under it', () => {
    expect(slotAt(layout, 10, 10, 8)).toBe(0);
    expect(slotAt(layout, pitchX + 6, 10, 8)).toBe(1);
    expect(slotAt(layout, 10, pitchY + 3, 8)).toBe(4);
    expect(slotAt(layout, 3 * pitchX + 10, pitchY + 10, 8)).toBe(7);
  });

  test('gaps, the outside and empty slots are dead zones', () => {
    expect(slotAt(layout, layout.cardWidth + layout.gap / 2, 10, 8)).toBe(-1);
    expect(slotAt(layout, 10, layout.cardHeight + layout.gap / 2, 8)).toBe(-1);
    expect(slotAt(layout, -1, 10, 8)).toBe(-1);
    expect(slotAt(layout, 4 * pitchX + 1, 10, 8)).toBe(-1);
    expect(slotAt(layout, 10, 2 * pitchY + 1, 8)).toBe(-1);
    expect(slotAt(layout, 3 * pitchX + 10, pitchY + 10, 6)).toBe(-1);
  });
});

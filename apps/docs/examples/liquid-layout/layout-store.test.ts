import { describe, expect, test, vi } from 'vitest';

import { CARDS, CARD_BY_ID } from './cards';
import { createLayoutStore, DEFAULT_SPRING, gridLayout, shuffled, createRandom, type CardHandle } from './layout-store';

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
    expect(layout.cardWidth / layout.cardHeight).toBeGreaterThanOrEqual(0.72);
    expect(layout.cardWidth / layout.cardHeight).toBeLessThanOrEqual(1.15 + 1 / layout.cardHeight);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count);
    return layout;
  };

  test('landscape frames get four columns', () => {
    // The fullscreen preview and the gallery iframe after padding, header and hint.
    expect(fits(1192, 584, 8)).toMatchObject({ columns: 4, rows: 2, cardWidth: 250 });
    expect(fits(744, 332, 8)).toMatchObject({ columns: 4, rows: 2 });
  });

  test('portrait frames and short lists get two', () => {
    expect(fits(358, 712, 8)).toMatchObject({ columns: 2, rows: 4 });
    expect(fits(1192, 584, 4)).toMatchObject({ columns: 2, rows: 2 });
    expect(fits(1192, 584, 1)).toMatchObject({ columns: 1, rows: 1 });
  });

  test('keeps a portrait-ish card in every frame', () => {
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

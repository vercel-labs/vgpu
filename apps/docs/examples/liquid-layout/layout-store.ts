// A tiny external store shared by the React cards (through useSyncExternalStore)
// and the renderer. It holds only discrete layout state: order, filter, the open
// card and the spring settings. Per-frame data never goes through it. Card
// components register a handle here so the renderer can read their DOM rects and
// motion values once per frame. The module imports nothing DOM-bound.

import { CARDS, CARD_BY_ID, type CardLibrary } from './cards';

export type Filter = 'all' | CardLibrary;
export type Layer = 'grid' | 'panel';
/** Who opened the panel: autoplay never moves keyboard focus. */
export type Opener = 'user' | 'auto';

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MeasurableElement {
  getBoundingClientRect(): RectLike;
}

export interface ValueLike {
  get(): number;
}

/** The part of a mounted card the renderer reads each frame. */
export interface CardHandle {
  readonly id: string;
  readonly layer: Layer;
  element: MeasurableElement | null;
  /** Drag offset (px): the card's distance from its layout slot. */
  readonly x: ValueLike;
  readonly y: ValueLike;
  readonly scale: ValueLike;
  /** Degrees. */
  readonly rotate: ValueLike;
  /** False once AnimatePresence starts the card's exit. */
  present: boolean;
  hovered: boolean;
}

export interface LayoutState {
  readonly order: readonly string[];
  readonly filter: Filter;
  readonly expanded: string | null;
  readonly openedBy: Opener | null;
  /** The card flying back from the panel; it stays on top until it lands. */
  readonly returning: string | null;
  readonly stiffness: number;
  readonly damping: number;
}

export interface LayoutStore {
  getState(): LayoutState;
  subscribe(listener: () => void): () => void;
  visible(state?: LayoutState): string[];
  shuffle(): void;
  setFilter(filter: Filter): void;
  expand(id: string, openedBy?: Opener): void;
  collapse(): void;
  settle(id: string): void;
  setSpring(spring: { stiffness?: number; damping?: number }): void;
  register(handle: CardHandle): () => void;
  handles(): IterableIterator<CardHandle>;
}

export const DEFAULT_SPRING = { stiffness: 170, damping: 21 } as const;

/** mulberry32: small, seeded and good enough for shuffling eight cards. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A permutation that moves most cards: at most one card keeps its place. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  let best = [...items];
  let bestFixed = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 12; attempt++) {
    const next = [...items];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
    const fixed = next.reduce((count, item, index) => count + (item === items[index] ? 1 : 0), 0);
    if (fixed < bestFixed) {
      best = next;
      bestFixed = fixed;
    }
    if (fixed <= (items.length > 2 ? 1 : 0)) break;
  }
  return best;
}

export function createLayoutStore(seed = 7): LayoutStore {
  const random = createRandom(seed);
  const listeners = new Set<() => void>();
  const registry = new Map<string, CardHandle>();
  let state: LayoutState = {
    order: CARDS.map((card) => card.id),
    filter: 'all',
    expanded: null,
    openedBy: null,
    returning: null,
    ...DEFAULT_SPRING,
  };

  const update = (patch: Partial<LayoutState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const visible = (current: LayoutState = state) =>
    current.order.filter((id) => current.filter === 'all' || CARD_BY_ID.get(id)?.library === current.filter);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visible,
    shuffle() {
      // Shuffle the visible cards among their own positions; hidden ones keep theirs.
      const shown = visible();
      const next = shuffled(shown, random);
      let cursor = 0;
      const shownSet = new Set(shown);
      update({ order: state.order.map((id) => (shownSet.has(id) ? next[cursor++]! : id)) });
    },
    setFilter(filter) {
      if (filter === state.filter) return;
      const next = { ...state, filter };
      const shown = visible(next);
      const keep = (id: string | null) => (id !== null && shown.includes(id) ? id : null);
      const expanded = keep(state.expanded);
      update({ filter, expanded, openedBy: expanded ? state.openedBy : null, returning: keep(state.returning) });
    },
    expand(id, openedBy = 'user') {
      if (!visible().includes(id) || state.expanded === id) return;
      update({ expanded: id, openedBy, returning: null });
    },
    collapse() {
      if (!state.expanded) return;
      update({ expanded: null, openedBy: null, returning: state.expanded });
    },
    settle(id) {
      if (state.returning === id) update({ returning: null });
    },
    setSpring({ stiffness = state.stiffness, damping = state.damping }) {
      if (stiffness === state.stiffness && damping === state.damping) return;
      update({ stiffness, damping });
    },
    register(handle) {
      registry.set(handle.id, handle);
      return () => {
        if (registry.get(handle.id) === handle) registry.delete(handle.id);
      };
    },
    handles: () => registry.values(),
  };
}

export interface GridLayout {
  readonly columns: number;
  readonly rows: number;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly gap: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Sizes the card grid for the space left between the header and the hint.
 * Landscape frames get four columns (two when four cards or fewer are shown),
 * portrait frames two. Cards keep a portrait-ish aspect between 0.72 and 1.15.
 */
export function gridLayout(width: number, height: number, count: number): GridLayout {
  const portrait = width < height * 0.9;
  const columns = Math.max(1, Math.min(count, portrait || count <= 4 ? 2 : 4));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gap = Math.round(Math.min(22, Math.max(12, Math.min(width, height) * 0.028)));
  const maxWidth = count <= 4 ? 320 : 250;
  const fitWidth = (width - gap * (columns - 1)) / columns;
  const fitHeight = (height - gap * (rows - 1)) / rows;
  let cardWidth = Math.min(maxWidth, fitWidth);
  let cardHeight = Math.min(fitHeight, cardWidth / 0.8);
  // Too wide for the height: narrow the card instead of flattening it further.
  if (cardWidth / cardHeight > 1.15) cardWidth = cardHeight * 1.15;
  if (cardWidth / cardHeight < 0.72) cardHeight = cardWidth / 0.72;
  cardWidth = Math.max(40, Math.floor(cardWidth));
  cardHeight = Math.max(40, Math.floor(cardHeight));
  return {
    columns,
    rows,
    cardWidth,
    cardHeight,
    gap,
    width: columns * cardWidth + (columns - 1) * gap,
    height: rows * cardHeight + (rows - 1) * gap,
  };
}

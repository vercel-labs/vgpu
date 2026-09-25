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
  /** Moves a card to `index` among the visible cards; returns whether the order changed. */
  move(id: string, index: number): boolean;
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
    move(id, index) {
      // Reorder within the visible cards; hidden ones keep their positions.
      const shown = visible();
      const from = shown.indexOf(id);
      const to = Math.max(0, Math.min(shown.length - 1, Math.round(index)));
      if (from < 0 || from === to) return false;
      const next = [...shown];
      next.splice(from, 1);
      next.splice(to, 0, id);
      let cursor = 0;
      const shownSet = new Set(shown);
      update({ order: state.order.map((card) => (shownSet.has(card) ? next[cursor++]! : card)) });
      return true;
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
 * Sizes the card grid for the space it is given. Landscape frames get four
 * columns (two when four cards or fewer are shown), portrait frames two. Cards
 * prefer a slightly wide aspect (square on a phone) and flatten to at most 1.3.
 */
export function gridLayout(width: number, height: number, count: number): GridLayout {
  const portrait = width < height * 0.9;
  const columns = Math.max(1, Math.min(count, portrait || count <= 4 ? 2 : 4));
  const rows = Math.max(1, Math.ceil(count / columns));
  // Wide enough for a liquid neck to read between row neighbours.
  const gap = Math.round(Math.min(30, Math.max(12, Math.min(width, height) * 0.042)));
  const maxWidth = count <= 4 ? 320 : 300;
  const aspect = portrait ? 1 : 1.2;
  const fitWidth = (width - gap * (columns - 1)) / columns;
  const fitHeight = (height - gap * (rows - 1)) / rows;
  let cardWidth = Math.min(maxWidth, fitWidth);
  let cardHeight = Math.min(fitHeight, cardWidth / aspect);
  // Too wide for the height: narrow the card instead of flattening it further.
  if (cardWidth / cardHeight > 1.3) cardWidth = cardHeight * 1.3;
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

export interface GridFrame extends GridLayout {
  /** The grid's top-left corner inside the frame (CSS px). */
  readonly left: number;
  readonly top: number;
}

/** Room kept clear above the grid for the closed lil-gui bar. */
const GUI_CLEARANCE = 52;
/**
 * On a narrow frame the bar spans the first row, so the clearance also covers
 * how far the row's top edges bulge and its bubbles rise.
 */
const NARROW_GUI_CLEARANCE = 62;

/**
 * Places the grid in a frame: sized for the space below the closed GUI bar and
 * centred in the whole frame when it fits. The DOM and the thumbnail share it.
 */
export function gridFrame(width: number, height: number, count: number): GridFrame {
  const narrow = width < 560;
  const clearance = narrow ? NARROW_GUI_CLEARANCE : GUI_CLEARANCE;
  const padX = narrow ? 14 : Math.round(Math.min(40, Math.max(20, width * 0.03)));
  const bottom = narrow ? 16 : 22;
  const layout = gridLayout(Math.max(0, width - padX * 2), Math.max(0, height - clearance - bottom), count);
  return {
    ...layout,
    left: Math.round((width - layout.width) / 2),
    top: Math.round(Math.max(clearance, (height - layout.height) / 2)),
  };
}

/** Corner radius (CSS px) of a card or the panel; the DOM focus ring and the liquid share it. */
export function cornerRadius(width: number, height: number): number {
  return Math.round(Math.min(32, Math.max(18, Math.min(width, height) * 0.13)));
}

const ARROW_STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const;

export function isArrowKey(key: string): key is keyof typeof ARROW_STEPS {
  return Object.hasOwn(ARROW_STEPS, key);
}

/**
 * Where an arrow key moves the card at `index` among `count` slots laid out in
 * `columns` columns, or null at the grid's edge. Left and Right wrap across
 * rows like reading order; Up and Down keep the column.
 */
export function keyedIndex(key: string, index: number, count: number, columns: number): number | null {
  if (!isArrowKey(key) || index < 0 || index >= count) return null;
  const [dx, dy] = ARROW_STEPS[key];
  const next = index + dx + dy * columns;
  return next >= 0 && next < count ? next : null;
}

/** The visible index of the slot under a grid-space point, or -1 over a gap or outside. */
export function slotAt(layout: GridLayout, x: number, y: number, count: number): number {
  const pitchX = layout.cardWidth + layout.gap;
  const pitchY = layout.cardHeight + layout.gap;
  const column = Math.floor(x / pitchX);
  const row = Math.floor(y / pitchY);
  if (column < 0 || column >= layout.columns || row < 0 || row >= layout.rows) return -1;
  // The gaps between slots are dead zones, so a card resting on a border does not flicker.
  if (x - column * pitchX > layout.cardWidth || y - row * pitchY > layout.cardHeight) return -1;
  const index = row * layout.columns + column;
  return index < count ? index : -1;
}

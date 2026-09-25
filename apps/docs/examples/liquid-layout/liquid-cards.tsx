'use client';

// The DOM half of the demo: eight real buttons laid out by CSS grid and moved
// by Motion. Shuffles, filters and drag reorders are `layout` animations,
// filtering in and out runs through AnimatePresence (popLayout), and opening a
// card is a `layoutId` hand-off to the panel. The cards carry no fill of their
// own: each one registers a handle with the store, and the renderer pours
// liquid glass under it every frame.

import {
  AnimatePresence,
  LayoutGroup,
  motion,
  MotionConfig,
  useIsPresent,
  useMotionValue,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
  type PanInfo,
} from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';

import { CARD_BY_ID, type CardData } from './cards';
import {
  cornerRadius,
  gridFrame,
  isArrowKey,
  keyedIndex,
  slotAt,
  type CardHandle,
  type GridLayout,
  type LayoutStore,
} from './layout-store';

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Spring {
  readonly stiffness: number;
  readonly damping: number;
}

const ENTER_DELAY = 0.3;
const ENTER_STAGGER = 0.06;
const FLIGHT_COPY_MS = 420;
const HELP_ID = 'liquid-layout-help';

const LIBRARY_LABEL = { vgpu: 'vgpu', motion: 'Motion' } as const;
const LIBRARY_DOT = { vgpu: 'bg-[#8cc8f5]', motion: 'bg-[#c89bf5]' } as const;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Registers a card with the store so the renderer can read it each frame. */
function useCardHandle(store: LayoutStore, id: string, layer: CardHandle['layer'], values: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  rotate: MotionValue<number>;
}) {
  const { x, y, scale, rotate } = values;
  const handle = useMemo<CardHandle>(
    () => ({ id, layer, element: null, x, y, scale, rotate, present: true, hovered: false }),
    [id, layer, x, y, scale, rotate],
  );
  useLayoutEffect(() => store.register(handle), [store, handle]);
  return handle;
}

interface CardProps {
  readonly card: CardData;
  readonly store: LayoutStore;
  readonly layout: GridLayout;
  readonly grid: RefObject<HTMLElement | null>;
  readonly enterDelay: number;
  readonly dimmed: boolean;
  /** Another card is being dragged: this one's copy steps back. */
  readonly muted: boolean;
  /** Dragged or flying back from the panel: drawn above the other cards. */
  readonly raised: boolean;
  readonly spring: Spring;
  readonly returnFocus: RefObject<string | null>;
  readonly onOpen: (id: string) => void;
  readonly onDragChange: (id: string, active: boolean) => void;
  readonly onMoved: (id: string) => void;
  readonly ref?: Ref<HTMLElement>;
}

function Card({
  card,
  store,
  layout,
  grid,
  enterDelay,
  dimmed,
  muted,
  raised,
  spring,
  returnFocus,
  onOpen,
  onDragChange,
  onMoved,
  ref,
}: CardProps) {
  const isPresent = useIsPresent();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  // Flicks tilt the card a little, like a tray of liquid swinging on release.
  const tilt = useTransform(useVelocity(x), [-1800, 1800], [-8, 8], { clamp: true });
  const rotate = useSpring(tilt, { stiffness: 320, damping: 24 });
  const handle = useCardHandle(store, card.id, 'grid', { x, y, scale, rotate });
  const dragged = useRef(false);
  const holding = useRef(false);
  // Pointer position relative to the card centre when the drag began.
  const grab = useRef({ x: 0, y: 0, index: -1 });
  const entered = useRef(enterDelay < 0);
  // Text sinks into the liquid while the card flies, so crossing cards do not
  // stack their copy. It resurfaces once most of the distance is covered.
  const [flying, setFlying] = useState(false);
  const landing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const button = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    handle.present = isPresent;
  }, [handle, isPresent]);

  useEffect(() => () => clearTimeout(landing.current), []);
  useEffect(() => () => onDragChange(card.id, false), [card.id, onDragChange]);

  const takeOff = () => {
    // The held card follows the pointer; only the cards it displaces fly.
    if (holding.current) return;
    setFlying(true);
    clearTimeout(landing.current);
    landing.current = setTimeout(() => setFlying(false), FLIGHT_COPY_MS);
  };

  useEffect(() => {
    if (returnFocus.current !== card.id) return;
    returnFocus.current = null;
    button.current?.focus({ preventScroll: true });
  }, [card.id, returnFocus]);

  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      handle.element = node;
      button.current = node;
      assignRef(ref, node);
    },
    [handle, ref],
  );

  // Motion keeps a dragged element under the pointer while its layout slot
  // moves, so reordering is only a matter of picking the slot under the card's
  // centre. Reorder.Group is a one-axis list; the grid does its own hit test.
  const onDrag = (_event: unknown, info: PanInfo) => {
    const box = grid.current?.getBoundingClientRect();
    if (!box) return;
    const centreX = info.point.x - window.scrollX - grab.current.x - box.left;
    const centreY = info.point.y - window.scrollY - grab.current.y - box.top;
    const visible = store.visible();
    const slot = slotAt(layout, centreX, centreY, visible.length);
    if (slot >= 0 && visible[slot] !== card.id) store.move(card.id, slot);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || !isArrowKey(event.key)) return;
    // Alt+Arrow is the browser's Back/Forward on Windows and Linux: swallow it on
    // a card even at the grid's edge, where the card stays put.
    event.preventDefault();
    const visible = store.visible();
    const next = keyedIndex(event.key, visible.indexOf(card.id), visible.length, layout.columns);
    if (next !== null && store.move(card.id, next)) onMoved(card.id);
  };

  const { cardWidth: width, cardHeight: height } = layout;
  const layoutSpring = { type: 'spring', stiffness: spring.stiffness, damping: spring.damping } as const;
  const title = Math.round(Math.min(26, Math.max(16, width * 0.085)));
  const body = Math.round(Math.min(16, Math.max(12, width * 0.053)) * 10) / 10;
  const pad = Math.round(Math.min(34, Math.max(14, width * 0.12)));
  const copyTop = Math.round(height * (height < 190 ? 0.36 : 0.4));

  return (
    <motion.button
      ref={setRef}
      type="button"
      data-card={card.id}
      data-library={card.library}
      aria-label={`${card.title}, ${LIBRARY_LABEL[card.library]}. Open details`}
      aria-describedby={HELP_ID}
      layout
      layoutId={card.id}
      drag
      dragSnapToOrigin
      dragTransition={{ bounceStiffness: spring.stiffness * 1.5, bounceDamping: spring.damping }}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      whileDrag={{ scale: 1.04 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{ layout: layoutSpring }}
      onHoverStart={() => {
        handle.hovered = true;
      }}
      onHoverEnd={() => {
        handle.hovered = false;
      }}
      onPointerDown={() => {
        dragged.current = false;
      }}
      onDragStart={(event) => {
        const box = button.current?.getBoundingClientRect();
        const point = 'clientX' in event ? event : event.touches[0];
        if (box && point) {
          grab.current = {
            x: point.clientX - (box.left + box.width / 2),
            y: point.clientY - (box.top + box.height / 2),
            index: store.visible().indexOf(card.id),
          };
        }
        dragged.current = true;
        holding.current = true;
        onDragChange(card.id, true);
      }}
      onDrag={onDrag}
      onDragEnd={() => {
        holding.current = false;
        if (store.visible().indexOf(card.id) !== grab.current.index) onMoved(card.id);
      }}
      // The card stays on top until it lands in its slot, not just until release.
      onDragTransitionEnd={() => onDragChange(card.id, false)}
      onKeyDown={onKeyDown}
      onClick={() => {
        // The click that ends a drag does not open the card; the next one does,
        // including a keyboard press, which sends no pointerdown.
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onOpen(card.id);
      }}
      onLayoutAnimationStart={takeOff}
      onLayoutAnimationComplete={() => {
        clearTimeout(landing.current);
        setFlying(false);
        store.settle(card.id);
      }}
      style={{
        x,
        y,
        scale,
        rotate,
        width,
        height,
        borderRadius: cornerRadius(width, height),
        zIndex: raised ? 15 : 1,
        touchAction: 'none',
      }}
      // The focus ring waits for the card to land: mid-flight, the layout
      // transform would stretch it with the card.
      className={`relative cursor-grab select-none text-left text-white outline-none active:cursor-grabbing ${
        flying || raised ? '' : 'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-white/60'
      }`}
    >
      <motion.span
        layout="position"
        className="absolute inset-0 block"
        initial={entered.current ? false : { opacity: 0, filter: 'blur(8px)' }}
        // Behind an open panel the copy goes out of focus: the glass above
        // refracts the liquid but cannot bend DOM text. In flight it all but
        // sinks, and while another card is dragged it steps back, so it never
        // reads through the copy of a card that crosses it.
        animate={{
          opacity: dimmed ? 0.22 : flying ? 0.15 : muted ? 0.28 : 1,
          filter: dimmed ? 'blur(3px)' : flying ? 'blur(2px)' : 'blur(0px)',
        }}
        // The copy's own layout correction must ride the card's spring, or it
        // lands early and leaves the liquid behind.
        transition={{ ...(entered.current ? { duration: 0.22 } : { duration: 0.45, delay: enterDelay }), layout: layoutSpring }}
        onAnimationComplete={() => {
          entered.current = true;
        }}
      >
        <span
          className="absolute flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-white/70"
          style={{ left: pad, top: Math.round(pad * 0.85) }}
        >
          <span className={`size-[7px] rounded-full ${LIBRARY_DOT[card.library]}`} />
          {LIBRARY_LABEL[card.library]}
        </span>
        <span
          className="absolute flex flex-col gap-2 [text-shadow:0_1px_10px_rgba(4,8,24,0.55)]"
          style={{ left: pad, right: pad, top: copyTop }}
        >
          <span className="font-mono font-semibold tracking-tight" style={{ fontSize: title, lineHeight: 1.1 }}>
            {card.title}
          </span>
          {height >= 130 ? (
            <span className="line-clamp-3 text-white/70" style={{ fontSize: body, lineHeight: 1.45 }}>
              {card.line}
            </span>
          ) : null}
        </span>
      </motion.span>
    </motion.button>
  );
}

interface SlotProps extends Omit<CardProps, 'ref'> {
  readonly placeholder: boolean;
  readonly ref?: Ref<HTMLElement>;
}

/** AnimatePresence child: the card, or an empty slot while its panel is open. */
function GridSlot({ placeholder, ref, ...props }: SlotProps) {
  if (placeholder) {
    return (
      <div
        ref={(node) => assignRef(ref, node)}
        aria-hidden="true"
        style={{ width: props.layout.cardWidth, height: props.layout.cardHeight }}
      />
    );
  }
  return <Card {...props} ref={ref} />;
}

interface PanelProps {
  readonly card: CardData;
  readonly store: LayoutStore;
  readonly bounds: Size;
  readonly spring: Spring;
  readonly autoFocus: boolean;
  readonly onClose: () => void;
}

function Panel({ card, store, bounds, spring, autoFocus, onClose }: PanelProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const rotate = useMotionValue(0);
  const handle = useCardHandle(store, card.id, 'panel', { x, y, scale, rotate });
  const close = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      handle.element = node;
    },
    [handle],
  );

  useEffect(() => {
    if (autoFocus) close.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const compact = bounds.width < 520 || bounds.height < 420;
  const width = Math.round(Math.min(600, bounds.width - (compact ? 32 : 96)));
  const height = Math.round(Math.min(360, bounds.height - (compact ? 120 : 150)));
  const titleId = `liquid-layout-panel-${card.id}`;
  const layoutSpring = { type: 'spring', stiffness: spring.stiffness, damping: spring.damping } as const;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <motion.div
        ref={setRef}
        // Non-modal: the cards behind it are inert, but the controls stay reachable.
        role="dialog"
        aria-labelledby={titleId}
        data-panel={card.id}
        layoutId={card.id}
        layout
        transition={{ layout: layoutSpring }}
        style={{ x, y, scale, rotate, width, height, borderRadius: cornerRadius(width, height) }}
        className="pointer-events-auto relative text-white"
      >
        <motion.div
          layout="position"
          className="flex h-full w-full flex-col"
          style={{ padding: compact ? 22 : 34, gap: compact ? 10 : 14 }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16, duration: 0.35, layout: layoutSpring }}
        >
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-white/70">
            <span className={`size-[7px] rounded-full ${LIBRARY_DOT[card.library]}`} />
            {LIBRARY_LABEL[card.library]}
          </span>
          <h2
            id={titleId}
            className="font-mono font-semibold tracking-tight [text-shadow:0_1px_14px_rgba(4,8,24,0.6)]"
            style={{ fontSize: compact ? 24 : 32, lineHeight: 1.05 }}
          >
            {card.title}
          </h2>
          <p
            className="max-w-[46ch] text-white/75 [text-shadow:0_1px_12px_rgba(4,8,24,0.6)]"
            style={{ fontSize: compact ? 13.5 : 15, lineHeight: 1.55 }}
          >
            {card.detail}
          </p>
          <code
            className="mt-auto block overflow-x-auto whitespace-nowrap rounded-xl bg-black/35 px-3.5 py-2.5 font-mono text-white/90"
            style={{ fontSize: compact ? 11.5 : 13 }}
          >
            {card.code}
          </code>
        </motion.div>
        <motion.button
          ref={close}
          type="button"
          aria-label="Close"
          data-close
          onClick={onClose}
          layout="position"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.16, duration: 0.35, layout: layoutSpring }}
          className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full bg-white/10 text-lg leading-none text-white/85 outline-none transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-white/60"
        >
          ×
        </motion.button>
      </motion.div>
    </div>
  );
}

export function LiquidCards({ store }: { store: LayoutStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const bounds = useRef<HTMLDivElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const size = useElementSize(bounds);
  const returnFocus = useRef<string | null>(null);
  const focused = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const visible = store.visible(state);
  const spring = { stiffness: state.stiffness, damping: state.damping };
  const frame = gridFrame(size.width, size.height, Math.max(1, visible.length));

  // Cards joining the grid fade their text in as their droplet lands, in reading
  // order. The previous list lives in state, so every render agrees on who is new.
  const visibleKey = visible.join(',');
  const [entry, setEntry] = useState({ key: visibleKey, entering: visible });
  if (entry.key !== visibleKey) {
    const before = new Set(entry.key.split(','));
    setEntry({ key: visibleKey, entering: visible.filter((id) => !before.has(id)) });
  }
  const { entering } = entry;

  const expanded = state.expanded ? CARD_BY_ID.get(state.expanded) : undefined;
  const userOpen = expanded !== undefined && state.openedBy === 'user';

  const [dragging, setDragging] = useState<string | null>(null);
  const onOpen = useCallback((id: string) => store.expand(id, 'user'), [store]);
  const onDragChange = useCallback((id: string, active: boolean) => {
    setDragging((current) => (active ? id : current === id ? null : current));
  }, []);
  const onMoved = useCallback(
    (id: string) => {
      const shown = store.visible();
      const title = CARD_BY_ID.get(id)?.title ?? id;
      setAnnouncement(`${title} moved to position ${shown.indexOf(id) + 1} of ${shown.length}`);
    },
    [store],
  );
  const onClose = useCallback(() => {
    const { expanded: id, openedBy } = store.getState();
    // Focus goes back to the card when the panel had it, whoever opened it.
    const focusInPanel = document.activeElement?.closest('[data-panel]') != null;
    if (id && (openedBy === 'user' || focusInPanel)) returnFocus.current = id;
    store.collapse();
  }, [store]);

  // A reorder moves DOM nodes, and moving the focused card drops focus to the
  // body. Put it back on the same card, whoever reordered the grid.
  useLayoutEffect(() => {
    const id = focused.current;
    if (!id || (document.activeElement !== document.body && document.activeElement !== null)) return;
    grid.current?.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus({ preventScroll: true });
  }, [visibleKey]);

  useEffect(() => {
    if (!state.expanded) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape in a field (a GUI number box, the docs search) belongs to that field.
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.expanded, onClose]);

  // A returning card normally settles when its layout animation completes; this is the fallback.
  useEffect(() => {
    const id = state.returning;
    if (!id) return;
    const timer = window.setTimeout(() => store.settle(id), 1400);
    return () => window.clearTimeout(timer);
  }, [state.returning, store]);

  const ready = size.width > 0 && size.height > 0;

  return (
    <MotionConfig reducedMotion="user">
      <div ref={bounds} className="absolute inset-0 isolate z-[1] overflow-hidden">
        <p id={HELP_ID} className="sr-only">
          Press Enter to open a card. Alt and an arrow key move the focused card; dragging a card onto another slot
          reorders the grid.
        </p>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        {ready ? (
          <LayoutGroup>
            <div
              ref={grid}
              inert={userOpen}
              className="absolute"
              onFocus={(event) => {
                focused.current = event.target.closest('[data-card]')?.getAttribute('data-card') ?? null;
              }}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && grid.current?.contains(next)) return;
                if (next) {
                  focused.current = null;
                  return;
                }
                // No new target: either the user blurred the card (focus sits on
                // the body afterwards) or a reorder moved it (restored above).
                const id = focused.current;
                queueMicrotask(() => {
                  if (focused.current === id && document.activeElement === document.body) focused.current = null;
                });
              }}
              style={{
                left: frame.left,
                top: frame.top,
                width: frame.width,
                height: frame.height,
                display: 'grid',
                gridTemplateColumns: `repeat(${frame.columns}, ${frame.cardWidth}px)`,
                gridAutoRows: `${frame.cardHeight}px`,
                gap: frame.gap,
              }}
            >
              <AnimatePresence mode="popLayout">
                {visible.map((id) => {
                  const card = CARD_BY_ID.get(id)!;
                  const rank = entering.indexOf(id);
                  return (
                    <GridSlot
                      key={id}
                      placeholder={state.expanded === id}
                      card={card}
                      store={store}
                      layout={frame}
                      grid={grid}
                      enterDelay={rank < 0 ? -1 : ENTER_DELAY + rank * ENTER_STAGGER}
                      dimmed={expanded !== undefined}
                      muted={dragging !== null && dragging !== id}
                      raised={state.returning === id || dragging === id}
                      spring={spring}
                      returnFocus={returnFocus}
                      onOpen={onOpen}
                      onDragChange={onDragChange}
                      onMoved={onMoved}
                    />
                  );
                })}
              </AnimatePresence>
            </div>

            {expanded ? (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  data-backdrop
                  className="absolute inset-0 z-20 cursor-default"
                  onClick={onClose}
                />
                <Panel
                  key={expanded.id}
                  card={expanded}
                  store={store}
                  bounds={size}
                  spring={spring}
                  autoFocus={userOpen}
                  onClose={onClose}
                />
              </>
            ) : null}
          </LayoutGroup>
        ) : null}
      </div>
    </MotionConfig>
  );
}

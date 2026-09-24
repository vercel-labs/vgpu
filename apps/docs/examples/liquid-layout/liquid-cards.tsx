'use client';

// The DOM half of the demo: eight real buttons laid out by CSS grid and moved
// by Motion. Shuffles and filters are `layout` animations, filtering in and out
// runs through AnimatePresence (popLayout), opening a card is a `layoutId`
// hand-off to the panel, and cards drag with snap-back. The cards carry no
// fill of their own: each one registers a handle with the store, and the
// renderer pours liquid glass under it every frame.

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
} from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type RefObject,
} from 'react';

import { CARD_BY_ID, type CardData } from './cards';
import { gridLayout, type CardHandle, type LayoutStore } from './layout-store';

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

const LIBRARY_LABEL = { vgpu: 'vgpu', motion: 'Motion' } as const;
const LIBRARY_DOT = { vgpu: 'bg-sky-300', motion: 'bg-fuchsia-300' } as const;

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
  readonly width: number;
  readonly height: number;
  readonly enterDelay: number;
  readonly dimmed: boolean;
  /** Another card is held or snapping back: this one's copy steps back. */
  readonly muted: boolean;
  readonly lifted: boolean;
  readonly spring: Spring;
  readonly bounds: RefObject<HTMLElement | null>;
  readonly returnFocus: RefObject<string | null>;
  readonly onOpen: (id: string) => void;
  readonly onDragChange: (id: string, active: boolean) => void;
  readonly ref?: Ref<HTMLElement>;
}

function Card({
  card,
  store,
  width,
  height,
  enterDelay,
  dimmed,
  muted,
  lifted,
  spring,
  bounds,
  returnFocus,
  onOpen,
  onDragChange,
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

  const layoutSpring = { type: 'spring', stiffness: spring.stiffness, damping: spring.damping } as const;
  const title = Math.round(Math.min(24, Math.max(15, width * 0.092)));
  const body = Math.round(Math.min(14, Math.max(11.5, width * 0.053)) * 10) / 10;
  const pad = Math.round(Math.min(20, Math.max(12, width * 0.075)));

  return (
    <motion.button
      ref={setRef}
      type="button"
      data-card={card.id}
      data-library={card.library}
      aria-label={`${card.title}, ${LIBRARY_LABEL[card.library]}. Open details`}
      layout
      layoutId={card.id}
      drag
      dragSnapToOrigin
      dragConstraints={bounds}
      dragElastic={0.2}
      dragTransition={{ bounceStiffness: spring.stiffness * 1.5, bounceDamping: spring.damping }}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      whileDrag={{ scale: 1.06, zIndex: 20 }}
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
      onDragStart={() => {
        dragged.current = true;
        onDragChange(card.id, true);
      }}
      // Neighbours stay muted until the snap-back lands, not just until release.
      onDragTransitionEnd={() => onDragChange(card.id, false)}
      onClick={() => {
        if (dragged.current) return;
        onOpen(card.id);
      }}
      onLayoutAnimationStart={takeOff}
      onLayoutAnimationComplete={() => {
        clearTimeout(landing.current);
        setFlying(false);
        store.settle(card.id);
      }}
      style={{ x, y, scale, rotate, width, height, borderRadius: 22, zIndex: lifted ? 15 : 1, touchAction: 'none' }}
      // The focus ring waits for the card to land: mid-flight, the layout
      // transform would stretch it with the card.
      className={`relative cursor-grab select-none text-left text-white outline-none active:cursor-grabbing ${
        flying || lifted ? '' : 'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-white/60'
      }`}
    >
      <motion.span
        layout="position"
        className="flex h-full w-full flex-col justify-between"
        style={{ padding: pad }}
        initial={entered.current ? false : { opacity: 0, filter: 'blur(8px)' }}
        // Behind an open panel the copy goes out of focus: the glass above
        // refracts the liquid but cannot bend DOM text.
        animate={{
          opacity: dimmed ? 0.22 : flying || muted ? 0.4 : 1,
          filter: dimmed ? 'blur(3px)' : flying ? 'blur(2px)' : 'blur(0px)',
        }}
        // The copy's own layout correction must ride the card's spring, or it
        // lands early and leaves the liquid behind.
        transition={{ ...(entered.current ? { duration: 0.22 } : { duration: 0.45, delay: enterDelay }), layout: layoutSpring }}
        onAnimationComplete={() => {
          entered.current = true;
        }}
      >
        <span className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/65">
          <span className={`size-1.5 rounded-full ${LIBRARY_DOT[card.library]}`} />
          {LIBRARY_LABEL[card.library]}
        </span>
        <span className="flex flex-col gap-1.5 [text-shadow:0_1px_12px_rgba(0,0,0,0.45)]">
          <span className="font-mono font-semibold tracking-tight" style={{ fontSize: title, lineHeight: 1.1 }}>
            {card.title}
          </span>
          {height >= 130 ? (
            <span className="text-white/75" style={{ fontSize: body, lineHeight: 1.4 }}>
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
        style={{ width: props.width, height: props.height }}
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-panel={card.id}
        layoutId={card.id}
        layout
        transition={{ layout: layoutSpring }}
        style={{ x, y, scale, rotate, width, height, borderRadius: 30 }}
        className="pointer-events-auto relative text-white"
      >
        <motion.div
          layout="position"
          className="flex h-full w-full flex-col"
          style={{ padding: compact ? 20 : 30, gap: compact ? 10 : 14 }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16, duration: 0.35, layout: layoutSpring }}
        >
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-white/65">
            <span className={`size-1.5 rounded-full ${LIBRARY_DOT[card.library]}`} />
            {LIBRARY_LABEL[card.library]}
          </span>
          <h2
            id={titleId}
            className="font-mono font-semibold tracking-tight [text-shadow:0_1px_16px_rgba(0,0,0,0.5)]"
            style={{ fontSize: compact ? 24 : 32, lineHeight: 1.05 }}
          >
            {card.title}
          </h2>
          <p
            className="max-w-[46ch] text-white/80 [text-shadow:0_1px_12px_rgba(0,0,0,0.5)]"
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
  const size = useElementSize(bounds);
  const returnFocus = useRef<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const visible = store.visible(state);
  const spring = { stiffness: state.stiffness, damping: state.damping };
  const narrow = size.width < 560;
  const padX = narrow ? 16 : 44;
  // On a phone the title drops below the closed GUI bar.
  const top = narrow ? 80 : 76;
  const bottom = narrow ? 52 : 60;
  const areaWidth = Math.max(0, size.width - padX * 2);
  const areaHeight = Math.max(0, size.height - top - bottom);
  const layout = gridLayout(areaWidth, areaHeight, Math.max(1, visible.length));

  // Cards joining the grid fade their text in as their droplet lands, in reading order.
  const previous = seen.current;
  const entering = visible.filter((id) => !previous || !previous.has(id));
  useEffect(() => {
    seen.current = new Set(visible);
  });

  const expanded = state.expanded ? CARD_BY_ID.get(state.expanded) : undefined;
  const userOpen = expanded !== undefined && state.openedBy === 'user';

  const [dragging, setDragging] = useState<string | null>(null);
  const onOpen = useCallback((id: string) => store.expand(id, 'user'), [store]);
  const onDragChange = useCallback((id: string, active: boolean) => {
    setDragging((current) => (active ? id : current === id ? null : current));
  }, []);
  const onClose = useCallback(() => {
    const { expanded: id, openedBy } = store.getState();
    if (id && openedBy === 'user') returnFocus.current = id;
    store.collapse();
  }, [store]);

  useEffect(() => {
    if (!state.expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
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
        <header
          className="pointer-events-none absolute left-0 select-none"
          style={{ top: narrow ? 20 : 22, left: padX, maxWidth: narrow ? size.width - 32 : 420 }}
        >
          <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-white/55">Motion × vgpu</p>
          <p className={`${narrow ? 'mt-3 text-[15px]' : 'mt-1 text-[19px]'} font-medium tracking-tight text-white/90`}>
            Every card is a drop of liquid glass
          </p>
        </header>

        {ready ? (
          <LayoutGroup>
            <div
              inert={userOpen}
              className="absolute"
              style={{
                left: padX + (areaWidth - layout.width) / 2,
                top: top + (areaHeight - layout.height) / 2,
                width: layout.width,
                height: layout.height,
                display: 'grid',
                gridTemplateColumns: `repeat(${layout.columns}, ${layout.cardWidth}px)`,
                gridAutoRows: `${layout.cardHeight}px`,
                gap: layout.gap,
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
                      width={layout.cardWidth}
                      height={layout.cardHeight}
                      enterDelay={rank < 0 ? -1 : ENTER_DELAY + rank * ENTER_STAGGER}
                      dimmed={expanded !== undefined}
                      muted={dragging !== null && dragging !== id}
                      lifted={state.returning === id || dragging === id}
                      spring={spring}
                      bounds={bounds}
                      returnFocus={returnFocus}
                      onOpen={onOpen}
                      onDragChange={onDragChange}
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

        <p
          className="pointer-events-none absolute inset-x-0 select-none text-center text-[11.5px] tracking-wide text-white/45"
          style={{ bottom: narrow ? 18 : 22 }}
        >
          Drag a card · click to open · shuffle and filter from the panel
        </p>
      </div>
    </MotionConfig>
  );
}

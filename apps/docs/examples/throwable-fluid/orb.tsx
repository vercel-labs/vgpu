'use client';

// The DOM half of the demo: one real, transparent button that Motion drags,
// throws and bounces. `drag` with `dragMomentum` hands the release velocity to
// Motion's inertia, `dragConstraints` keeps it inside the canvas, and
// `dragTransition` (bound live to lil-gui through the store) sets how far it
// coasts and how it springs back from past a wall. Hover and press springs
// drive its `scale`. The button draws nothing itself: it registers a handle,
// and the renderer reads its rect and scale each frame to draw the glass lens
// and stir the ink.

import { animate, motion, useMotionValue } from 'motion/react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

import { flickCoast, inertiaOptions, rescaleOffset, type OrbHandle, type OrbStore } from './orb-store';

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Arrow keys flick the orb at this speed (Shift doubles it), CSS px per second. */
const KEY_FLICK_SPEED = 1100;
const KEY_DIRECTIONS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
/** Where the orb first rests, as a share of the bounds. */
const START = [0.3, 0.56] as const;
/** The orb never grows past this share of the short side. */
const MAX_SHARE = 0.3;
const SCALE_SPRING = { type: 'spring', stiffness: 420, damping: 22 } as const;

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

export function Orb({ store }: { readonly store: OrbStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const boundsRef = useRef<HTMLDivElement>(null);
  const bounds = useElementSize(boundsRef);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const placed = useRef(false);
  const dragged = useRef(false);
  const descriptionId = useId();

  const shortSide = Math.min(bounds.width, bounds.height);
  const size = Math.round(Math.max(40, Math.min(state.size, shortSide * MAX_SHARE)));
  const maxX = Math.max(0, bounds.width - size);
  const maxY = Math.max(0, bounds.height - size);
  // Object constraints rather than the bounds ref: Motion rescales a ref-constrained
  // position on every resize from a stale measurement, walking the orb into a
  // corner. The layout effect below keeps it in place instead.
  const constraints = useMemo(() => ({ left: 0, top: 0, right: maxX, bottom: maxY }), [maxX, maxY]);
  const range = useRef({ x: 0, y: 0 });

  const handle = useMemo<OrbHandle>(
    () => ({
      element: null,
      bounds: null,
      scale,
      flick(vx, vy) {
        const options = inertiaOptions(store.getState());
        for (const [value, impulse, max] of [
          [x, vx, range.current.x],
          [y, vy, range.current.y],
        ] as const) {
          const coast = flickCoast(value.get(), value.getVelocity(), impulse, max, options.power);
          if (!coast) continue;
          animate(value, [...coast.keyframes], { type: 'inertia', velocity: coast.velocity, min: 0, max, ...options });
        }
      },
    }),
    [store, scale, x, y],
  );
  useLayoutEffect(() => {
    const unregister = store.register(handle);
    return () => {
      unregister();
      // Coasts started by a flick run on these values, not on the element.
      x.stop();
      y.stop();
    };
  }, [store, handle, x, y]);

  // Place the orb once the bounds are known; when they (or the orb) resize,
  // keep its share of the room it can move in.
  useLayoutEffect(() => {
    if (bounds.width === 0 || bounds.height === 0) return;
    const previous = range.current;
    range.current = { x: maxX, y: maxY };
    if (!placed.current) {
      placed.current = true;
      x.set(Math.min(maxX, Math.max(0, bounds.width * START[0] - size / 2)));
      y.set(Math.min(maxY, Math.max(0, bounds.height * START[1] - size / 2)));
      return;
    }
    for (const [value, from, to] of [
      [x, previous.x, maxX],
      [y, previous.y, maxY],
    ] as const) {
      if (from === to) continue;
      value.stop();
      value.set(rescaleOffset(value.get(), from, to));
    }
  }, [bounds.width, bounds.height, size, maxX, maxY, x, y]);

  const setOrb = useCallback(
    (node: HTMLButtonElement | null) => {
      handle.element = node;
    },
    [handle],
  );
  const setBounds = useCallback(
    (node: HTMLDivElement | null) => {
      boundsRef.current = node;
      handle.bounds = node;
    },
    [handle],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction = KEY_DIRECTIONS[event.key];
    if (!direction) return;
    event.preventDefault();
    const speed = KEY_FLICK_SPEED * (event.shiftKey ? 2 : 1);
    handle.flick(direction[0] * speed, direction[1] * speed);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A mouse drag ends with a click on the orb; keyboard clicks (detail 0) always ripple.
    if (dragged.current && event.detail !== 0) {
      dragged.current = false;
      return;
    }
    store.requestRipple();
  };

  const reduced = state.reduced;
  const interaction = store.interaction;

  return (
    <div ref={setBounds} className="pointer-events-none absolute inset-0">
      <motion.button
        ref={setOrb}
        type="button"
        data-orb=""
        aria-label="Glass orb"
        aria-describedby={descriptionId}
        className="pointer-events-auto absolute left-0 top-0 cursor-grab rounded-full outline-none active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-white/60"
        style={{ x, y, scale, width: size, height: size, visibility: bounds.width > 0 ? 'visible' : 'hidden' }}
        drag
        dragMomentum
        dragConstraints={constraints}
        dragElastic={state.elastic}
        dragTransition={inertiaOptions(state)}
        whileHover={{ scale: reduced ? 1.02 : 1.05 }}
        whileTap={{ scale: reduced ? 1.04 : 1.12 }}
        whileDrag={{ scale: reduced ? 1.04 : 1.12 }}
        transition={{ scale: SCALE_SPRING }}
        onHoverStart={() => {
          interaction.hovered = true;
        }}
        onHoverEnd={() => {
          interaction.hovered = false;
        }}
        onPointerDown={() => {
          dragged.current = false;
        }}
        onTapStart={() => {
          interaction.pressed = true;
        }}
        onTap={() => {
          interaction.pressed = false;
        }}
        onTapCancel={() => {
          interaction.pressed = false;
        }}
        onDragStart={() => {
          dragged.current = true;
          interaction.dragging = true;
        }}
        onDragEnd={() => {
          interaction.dragging = false;
          interaction.pressed = false;
        }}
        onKeyDown={onKeyDown}
        onClick={onClick}
      >
        <span id={descriptionId} className="sr-only">
          Drag and throw it to stir the ink. Arrow keys flick it, Shift flicks harder, and Enter swirls the ink.
        </span>
      </motion.button>
    </div>
  );
}

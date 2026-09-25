// A tiny external store shared by the React orb (through useSyncExternalStore)
// and the renderer. It holds the discrete settings lil-gui edits — orb size
// and the drag physics handed to Motion — plus flags React never renders:
// the pointer state the idle choreography waits on and pending ripples. The
// mounted orb registers a handle so the renderer can read its rect and scale
// once per frame and start a coast. The module imports nothing DOM-bound.

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

export interface ThrowSettings {
  /** Orb diameter, CSS px (the orb also stays under 30% of the short side). */
  readonly size: number;
  /** Motion inertia: coast distance = power × release velocity. */
  readonly power: number;
  /** Motion inertia: coast decay, ms. */
  readonly timeConstant: number;
  /** Motion's spring back from past a wall. */
  readonly bounceStiffness: number;
  readonly bounceDamping: number;
  /** How far a drag can pull past a wall (0..1). */
  readonly elastic: number;
}

export interface OrbState extends ThrowSettings {
  readonly reduced: boolean;
}

/** The part of the mounted orb the renderer reads each frame. */
export interface OrbHandle {
  element: MeasurableElement | null;
  bounds: MeasurableElement | null;
  readonly scale: ValueLike;
  /** Coasts the orb with Motion's inertia from its current position, CSS px per second. */
  flick(vx: number, vy: number): void;
}

/** Pointer state written by the orb's gesture callbacks and polled by the renderer. */
export interface Interaction {
  hovered: boolean;
  pressed: boolean;
  dragging: boolean;
}

export interface OrbStore {
  getState(): OrbState;
  subscribe(listener: () => void): () => void;
  setSettings(patch: Partial<ThrowSettings>): void;
  setReduced(reduced: boolean): void;
  readonly interaction: Interaction;
  requestRipple(): void;
  /** Ripples requested since the last call. */
  takeRipples(): number;
  register(handle: OrbHandle): () => void;
  handle(): OrbHandle | null;
}

export const DEFAULT_SETTINGS: ThrowSettings = {
  size: 120,
  power: 0.6,
  timeConstant: 600,
  bounceStiffness: 620,
  bounceDamping: 18,
  elastic: 0.3,
};

/** Motion's `dragTransition` (and the arrow-key and idle coasts) for these settings. */
export function inertiaOptions(settings: ThrowSettings) {
  return {
    power: settings.power,
    timeConstant: settings.timeConstant,
    bounceStiffness: settings.bounceStiffness,
    bounceDamping: settings.bounceDamping,
    restDelta: 1,
    restSpeed: 10,
  };
}

export interface Coast {
  readonly keyframes: readonly [number, number];
  /** CSS px per second. */
  readonly velocity: number;
}

/** Share of a flick into the wall the orb rests on that squashes it against the wall. */
export const THUMP = 0.5;

/**
 * The inertia coast a flick starts on one axis of the orb's offset (0..max),
 * or null when the flick leaves that axis alone.
 */
export function flickCoast(position: number, velocity: number, impulse: number, max: number, power: number): Coast | null {
  // An axis without an impulse keeps whatever it is doing.
  if (impulse === 0) return null;
  // Mid-bounce the orb can sit past a wall, and an inertia that starts out of
  // bounds only springs back: start it from the wall instead.
  const from = Math.min(max, Math.max(0, position));
  // Resting against a wall, a push into it thumps the orb against the wall
  // and Motion's bounce spring brings it back.
  const intoWall = (from <= 0 && impulse < 0) || (from >= max && impulse > 0);
  const next = intoWall ? impulse * THUMP : velocity + impulse;
  // Inertia coasts from the first keyframe and ignores the second, but Motion
  // completes at once when the keyframes do not change, so the second names
  // where the throw heads, as Motion's own drag does.
  return { keyframes: [from, from + next * power], velocity: next };
}

/**
 * Where an offset on one axis goes when its range (0..from) becomes 0..to: it
 * keeps its share of the range, so an orb resting on a wall stays on it.
 */
export function rescaleOffset(position: number, from: number, to: number): number {
  const share = from > 0 ? position / from : position > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, share)) * to;
}

export function createOrbStore(): OrbStore {
  const listeners = new Set<() => void>();
  let state: OrbState = { ...DEFAULT_SETTINGS, reduced: false };
  let current: OrbHandle | null = null;
  let ripples = 0;
  const interaction: Interaction = { hovered: false, pressed: false, dragging: false };

  const update = (patch: Partial<OrbState>) => {
    const next = { ...state, ...patch };
    if ((Object.keys(patch) as (keyof OrbState)[]).every((key) => next[key] === state[key])) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSettings: (patch) => update(patch),
    setReduced: (reduced) => update({ reduced }),
    interaction,
    requestRipple() {
      ripples++;
    },
    takeRipples() {
      const count = ripples;
      ripples = 0;
      return count;
    },
    register(handle) {
      current = handle;
      return () => {
        // A remount may register its handle before the old one unregisters.
        if (current === handle) current = null;
      };
    },
    handle: () => current,
  };
}

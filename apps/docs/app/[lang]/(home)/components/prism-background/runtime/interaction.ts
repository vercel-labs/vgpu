import { CAMERA_ORBIT_LERP, LAMP_AIM_LERP, PRISM_DEFAULT_ARC } from "../types";

type Pair = readonly [number, number];

const AUTO_POINTER_PERIOD_SECONDS = 18;
const AUTO_POINTER_RADIUS = 0.34;

export interface PrismInteraction {
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerLeave: () => void;
  /** Feeds the same normalized path as a real pointer without DOM events. */
  readonly setNormalizedPointer: (position: Pair) => void;
  /** Returns the eased value only when the lamp moved this frame. */
  stepAim(): Pair | undefined;
  /** Returns the eased value only when the camera orbit moved this frame. */
  stepOrbit(): Pair | undefined;
}

/** Pointer normalization and easing, independent from GPU/render ownership. */
export function createPrismInteraction(
  canvas: HTMLCanvasElement,
  invalidate: () => void
): PrismInteraction {
  let aimTarget: Pair = [PRISM_DEFAULT_ARC, 0.5];
  let aimCurrent: Pair = aimTarget;
  let orbitTarget: Pair = [0, 0];
  let orbitCurrent: Pair = orbitTarget;

  const setNormalizedPointer = (position: Pair) => {
    const x = clamp(position[0], 0, 1);
    const y = clamp(position[1], 0, 1);
    // Height swings the source; width chooses the point of impact.
    aimTarget = [y, x];
    // Hovering tilts only the camera, not the world-space light mesh.
    orbitTarget = [x * 2 - 1, y * 2 - 1];
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setNormalizedPointer([x, y]);
    invalidate();
  };

  return {
    onPointerMove,
    setNormalizedPointer,
    onPointerLeave() {
      orbitTarget = [0, 0];
    },
    stepAim() {
      const next = easedPair(aimCurrent, aimTarget, LAMP_AIM_LERP);
      if (next) aimCurrent = next;
      return next;
    },
    stepOrbit() {
      const next = easedPair(orbitCurrent, orbitTarget, CAMERA_ORBIT_LERP);
      if (next) orbitCurrent = next;
      return next;
    },
  };
}

/** A slow centered circle used as the virtual pointer on mobile layouts. */
export function automaticPointerPosition(timeSeconds: number): Pair {
  const phase =
    ((Number.isFinite(timeSeconds) ? timeSeconds : 0) /
      AUTO_POINTER_PERIOD_SECONDS) *
    Math.PI *
    2;
  return [
    0.5 + Math.cos(phase) * AUTO_POINTER_RADIUS,
    0.5 + Math.sin(phase) * AUTO_POINTER_RADIUS,
  ];
}

function easedPair(
  current: Pair,
  target: Pair,
  amount: number
): Pair | undefined {
  const dx = target[0] - current[0];
  const dy = target[1] - current[1];
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) {
    return current[0] === target[0] && current[1] === target[1]
      ? undefined
      : target;
  }
  return [current[0] + dx * amount, current[1] + dy * amount];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

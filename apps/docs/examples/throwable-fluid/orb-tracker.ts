// Turns the orb's DOM rectangle, read once per frame after Motion has written
// its transform, into what the GPU draws: the visual centre and its swept
// segment, the velocity, the lens squashed flat against a wall while Motion's
// bounce spring carries the element past it, and a contact whenever the orb
// crosses a wall fast enough to splash. Pure, so it runs in tests and in the
// thumbnail as well as on the page.

import type { RectLike } from './orb-store';

export type Vec2 = readonly [number, number];

export interface TrackerInput {
  /** The orb button's rect, including its hover/press scale. */
  readonly orb: RectLike;
  /** The drag constraints element. */
  readonly bounds: RectLike;
  /** The canvas; every output is relative to its top-left corner. */
  readonly canvas: RectLike;
  /** The orb's current scale motion value. */
  readonly scale: number;
}

export interface Contact {
  /** On the wall, CSS px. */
  readonly point: Vec2;
  /** Unit normal pointing into the field. */
  readonly normal: Vec2;
  /** Speed into the wall when the orb crossed it, CSS px per second. */
  readonly speed: number;
}

export interface TrackedOrb {
  /** Visual centre (after the squash), CSS px. */
  readonly center: Vec2;
  /** Visual centre on the previous frame. */
  readonly previous: Vec2;
  /** Visual velocity, CSS px per second. */
  readonly velocity: Vec2;
  readonly speed: number;
  /** Radius including the scale, CSS px. */
  readonly radius: number;
  /** Radii after the squash, CSS px. */
  readonly radii: Vec2;
  /** 0 resting .. 1 at the press scale. */
  readonly lift: number;
  readonly contacts: readonly Contact[];
}

/** Normal speed a wall crossing needs before it splashes, CSS px per second. */
export const SPLASH_SPEED = 220;
/** Press scale that counts as fully lifted. */
export const LIFT_SCALE = 1.12;
const MAX_SPEED = 5000;
const MIN_DT = 1 / 240;
/** How flat the lens gets against a wall, and how much it bulges sideways. */
const SQUASH = 0.42;
const BULGE = 0.22;

interface Walls {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Sample {
  readonly center: Vec2;
  readonly dom: Vec2;
  readonly overshoot: Walls;
  readonly walls: Walls;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function clampSpeed(x: number, y: number): Vec2 {
  const speed = Math.hypot(x, y);
  if (speed <= MAX_SPEED) return [x, y];
  const k = MAX_SPEED / speed;
  return [x * k, y * k];
}

export interface OrbTracker {
  update(input: TrackerInput, dt: number): TrackedOrb;
  /** Forget the previous frame, e.g. after a resize moved everything at once. */
  reset(): void;
}

export function createOrbTracker(): OrbTracker {
  let last: Sample | null = null;
  let velocity: Vec2 = [0, 0];

  return {
    reset() {
      last = null;
      velocity = [0, 0];
    },
    update({ orb, bounds, canvas, scale }, dt) {
      const safeScale = Math.max(scale, 1e-3);
      const radius = orb.width / 2;
      // Motion constrains the unscaled layout box, so contacts use its radius.
      const layoutRadius = radius / safeScale;
      const dom: Vec2 = [orb.left - canvas.left + radius, orb.top - canvas.top + orb.height / 2];
      const walls: Walls = {
        left: bounds.left - canvas.left,
        top: bounds.top - canvas.top,
        right: bounds.left - canvas.left + bounds.width,
        bottom: bounds.top - canvas.top + bounds.height,
      };
      const past = (r: number): Walls => ({
        left: walls.left - (dom[0] - r),
        top: walls.top - (dom[1] - r),
        right: dom[0] + r - walls.right,
        bottom: dom[1] + r - walls.bottom,
      });

      // The lens flattens against a wall the element has crossed, and bulges sideways.
      const visual = past(radius);
      const squashX = 1 - Math.exp(-Math.max(visual.left, visual.right, 0) / Math.max(radius, 1));
      const squashY = 1 - Math.exp(-Math.max(visual.top, visual.bottom, 0) / Math.max(radius, 1));
      const radii: Vec2 = [
        radius * (1 - SQUASH * squashX) * (1 + BULGE * squashY),
        radius * (1 - SQUASH * squashY) * (1 + BULGE * squashX),
      ];
      const center: Vec2 = [
        visual.left > 0 ? walls.left + radii[0] : visual.right > 0 ? walls.right - radii[0] : dom[0],
        visual.top > 0 ? walls.top + radii[1] : visual.bottom > 0 ? walls.bottom - radii[1] : dom[1],
      ];

      const sample: Sample = { center, dom, overshoot: past(layoutRadius), walls };
      const previous = last;
      last = sample;
      const moved =
        !previous ||
        previous.walls.left !== walls.left ||
        previous.walls.top !== walls.top ||
        previous.walls.right !== walls.right ||
        previous.walls.bottom !== walls.bottom;
      const lift = clamp01((scale - 1) / (LIFT_SCALE - 1));
      if (moved) {
        velocity = [0, 0];
        return { center, previous: center, velocity, speed: 0, radius, radii, lift, contacts: [] };
      }

      const step = Math.max(dt, MIN_DT);
      velocity = clampSpeed((center[0] - previous.center[0]) / step, (center[1] - previous.center[1]) / step);
      const domVelocity = clampSpeed((dom[0] - previous.dom[0]) / step, (dom[1] - previous.dom[1]) / step);

      const contacts: Contact[] = [];
      const crossed = (wall: keyof Walls) => previous.overshoot[wall] <= 0 && sample.overshoot[wall] > 0;
      const hit = (wall: keyof Walls, point: Vec2, normal: Vec2) => {
        const speed = -(domVelocity[0] * normal[0] + domVelocity[1] * normal[1]);
        if (crossed(wall) && speed > SPLASH_SPEED) contacts.push({ point, normal, speed });
      };
      hit('left', [walls.left, center[1]], [1, 0]);
      hit('right', [walls.right, center[1]], [-1, 0]);
      hit('top', [center[0], walls.top], [0, 1]);
      hit('bottom', [center[0], walls.bottom], [0, -1]);

      return {
        center,
        previous: previous.center,
        velocity,
        speed: Math.hypot(velocity[0], velocity[1]),
        radius,
        radii,
        lift,
        contacts,
      };
    },
  };
}

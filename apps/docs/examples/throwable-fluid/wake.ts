// Turns the tracked orb into what it does to the fluid each frame: the swept
// stroke, how hard it drags the fluid along, the splash a wall contact sends
// out over a few frames (the fluid thrown back off the wall, plus a burst of
// ink), the swirl of a keyboard ripple, and the ink's palette position, which
// advances with distance travelled. Pure, so the page and the thumbnail stir
// the tank the same way.

import type { Contact, TrackedOrb } from './orb-tracker';
import type { OrbFrame, SplashFrame } from './pipeline';

/** Contacts and ripples splash over this many frames. */
export const SPLASH_FRAMES = 4;
/** Rebound thrown back per splash frame, per unit of impact speed. */
const JET_GAIN = 0.3;
/** Impact speed that splashes the most ink, CSS px per second. */
const FULL_SPLASH_SPEED = 1600;
/** Splash ink at the slowest splashing impact and at full speed. */
const SPLASH_INK = [0.2, 0.6] as const;
/** Swirl per ripple frame, CSS px per second one splash radius out. */
const RIPPLE_SWIRL = 240;
const RIPPLE_INK = 0.45;
/** Ink arms a ripple lays around the orb for its swirl to wind up. */
const RIPPLE_ARMS = 3;
/** Share of the fluid under the orb pulled to its velocity per 1/60 s, at full speed. */
const DRAG = 0.35;
const DRAG_FULL_SPEED = 150;
/** A resting orb still holds the fluid under it a little. */
const DRAG_AT_REST = 0.15;
/** Palette laps per CSS px travelled and per second. */
const PHASE_PER_PX = 1 / 1400;
const PHASE_PER_SECOND = 0.015;

export interface WakeInput {
  readonly orb: TrackedOrb | null;
  readonly dt: number;
  /** Keyboard ripples requested since the last frame. */
  readonly ripples: number;
  /** Splash strength, 1 normally and lower under reduced motion. */
  readonly gain: number;
}

export interface WakeFrame {
  readonly orb: OrbFrame;
  readonly splash: SplashFrame | null;
  readonly phase: number;
  readonly drag: number;
}

export interface Wake {
  update(input: WakeInput): WakeFrame;
}

interface Pending extends SplashFrame {
  frames: number;
}

const HIDDEN: OrbFrame = { from: [0, 0], to: [0, 0], velocity: [0, 0], radius: 1, radii: [1, 1], lift: 0, visible: false };

export function createWake(): Wake {
  let phase = 0;
  let pending: Pending | null = null;
  // Ripples alternate their spin, so repeated ones knead the ink instead of spinning it up.
  let spin = 1;

  const splash = (contact: Contact, orb: TrackedOrb, gain: number) => {
    const [nx, ny] = contact.normal;
    const t = Math.min(1, contact.speed / FULL_SPLASH_SPEED);
    const jet = contact.speed * JET_GAIN * gain;
    pending = {
      // Just inside the wall, so the whole splash lands in the field.
      point: [contact.point[0] + nx * orb.radius * 0.5, contact.point[1] + ny * orb.radius * 0.5],
      radius: orb.radius * 1.5,
      jet: [nx * jet, ny * jet],
      swirl: 0,
      amount: (SPLASH_INK[0] + (SPLASH_INK[1] - SPLASH_INK[0]) * t) * gain,
      arms: 0,
      turn: 0,
      frames: SPLASH_FRAMES,
    };
  };

  const ripple = (orb: TrackedOrb, gain: number) => {
    spin = -spin;
    pending = {
      point: orb.center,
      radius: orb.radius * 1.6,
      jet: [0, 0],
      swirl: RIPPLE_SWIRL * spin * gain,
      amount: RIPPLE_INK * gain,
      arms: RIPPLE_ARMS,
      // Each ripple lays its arms somewhere new.
      turn: phase * Math.PI * 2 * RIPPLE_ARMS,
      frames: SPLASH_FRAMES,
    };
  };

  return {
    update({ orb, dt, ripples, gain }) {
      phase += dt * PHASE_PER_SECOND;
      if (!orb) return { orb: HIDDEN, splash: null, phase, drag: 0 };

      phase += Math.hypot(orb.center[0] - orb.previous[0], orb.center[1] - orb.previous[1]) * PHASE_PER_PX;
      let strongest: Contact | undefined;
      for (const contact of orb.contacts) if (!strongest || contact.speed > strongest.speed) strongest = contact;
      if (strongest) splash(strongest, orb, gain);
      if (ripples > 0) ripple(orb, gain);

      let current: SplashFrame | null = null;
      if (pending && pending.frames > 0) {
        pending.frames--;
        const { point, radius, jet, swirl, amount, arms, turn } = pending;
        current = { point, radius, jet, swirl, amount, arms, turn };
      }
      return {
        orb: {
          from: orb.previous,
          to: orb.center,
          velocity: orb.velocity,
          radius: orb.radius,
          radii: orb.radii,
          lift: orb.lift,
          visible: true,
        },
        splash: current,
        phase,
        drag: DRAG * Math.max(DRAG_AT_REST, Math.min(1, orb.speed / DRAG_FULL_SPEED)),
      };
    },
  };
}

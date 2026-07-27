export type Point = readonly [number, number];

export function autonomousLight(timeSeconds: number): Point {
  const phase = timeSeconds * 0.32;
  // The radius breathes on an incommensurate frequency, so the path precesses
  // instead of reading as a circle. Its minimum still clears a small central
  // exclusion zone (~0.21-0.28 logo-local) where crossing the glyph's middle
  // looks bad, while letting the light roam over the rest of the N.
  const radius = 0.34 + 0.09 * Math.sin(phase * 0.83);
  return [
    0.5 + Math.cos(phase) * radius * 1.1,
    0.5 - Math.sin(phase) * radius * 0.85,
  ];
}

const PULSE_TRANSITION_SECONDS = 2;
// The "off" state keeps a dim ember instead of an absolute blackout.
const PULSE_FLOOR = 0.2;

function pulseHash(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

// Deterministic on/off breathing for the light: alternating holds of 3-6s
// joined by 2s eased transitions, dipping to PULSE_FLOOR instead of zero.
// Pure in time so live rendering and static frames stay consistent.
export function lightPulse(timeSeconds: number): number {
  let remaining = Math.max(timeSeconds, 0);
  let index = 0;
  let on = true;
  for (;;) {
    // The first hold is pinned to the 6s maximum so early static frames
    // always sample the light fully on.
    const hold = index === 0 ? 6 : 3 + pulseHash(index) * 3;
    if (remaining < hold) return on ? 1 : PULSE_FLOOR;
    remaining -= hold;
    if (remaining < PULSE_TRANSITION_SECONDS) {
      const progress = remaining / PULSE_TRANSITION_SECONDS;
      const eased = progress * progress * (3 - 2 * progress);
      const raw = on ? 1 - eased : eased;
      return PULSE_FLOOR + (1 - PULSE_FLOOR) * raw;
    }
    remaining -= PULSE_TRANSITION_SECONDS;
    on = !on;
    index += 1;
  }
}

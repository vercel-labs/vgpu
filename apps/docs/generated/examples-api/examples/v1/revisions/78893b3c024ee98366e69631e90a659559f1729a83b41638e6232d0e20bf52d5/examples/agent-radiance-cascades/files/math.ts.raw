/** Four-times farther and four-times more directional at every cascade level. */
export const RC_BASE = 4;
export const RC_INTERVAL0 = 2;
export const RC_OVERLAP = 0.02;
export const RC_MIN_CASCADES = 5;
export const RC_MAX_CASCADES = 6;

export type Vec2 = readonly [number, number];

export function probeSpacing(cascade: number): number {
  return 2 ** cascade;
}

export function cascadeCountForSize(width: number, height: number): number {
  const diagonal = Math.hypot(width, height);
  const exact = Math.ceil(Math.log(1 + (3 * diagonal) / RC_INTERVAL0) / Math.log(RC_BASE));
  return Math.min(RC_MAX_CASCADES, Math.max(RC_MIN_CASCADES, exact));
}

/** Every level shares one atlas, so two textures can be ping-ponged for the full hierarchy. */
export function atlasSizeFor(width: number, height: number, count: number, directionBase = 2): Vec2 {
  const coarsest = probeSpacing(count - 1);
  const paddedWidth = Math.ceil(Math.max(1, width) / coarsest) * coarsest;
  const paddedHeight = Math.ceil(Math.max(1, height) / coarsest) * coarsest;
  return [paddedWidth * directionBase, paddedHeight * directionBase];
}

/** JFA+2: halve to one texel, then let the nearest-seed field settle twice more. */
export function jfaJumps(size: number): number[] {
  const passes = Math.ceil(Math.log2(Math.max(size, 2)));
  return [...Array.from({ length: passes }, (_, index) => Math.max(1, 2 ** (passes - index - 1))), 1, 1];
}

/** Render-budget tier. The scene owns what each tier means (passes, resolution, march steps). */
export type QualityTier = 'high' | 'low';

/** User-facing choice. `auto` always starts High and can only move to Low once. */
export type QualityPreference = 'auto' | QualityTier;

/** Which advisory signal asked for Low. */
export type DowngradeReason = 'gpu-tier' | 'battery' | 'frame-health';

/** Why the effective tier is what it is. */
export type QualityReason = 'initial' | 'forced' | DowngradeReason;

/** Separates what the user asked for from what is on screen, and why. */
export interface QualityState {
  readonly preference: QualityPreference;
  readonly effective: QualityTier;
  readonly reason: QualityReason;
}

/** Device pixel ratio per tier. Low renders at 1 CSS pixel = 1 texel; High clamps to [1, 2]. */
export const TIER_DPR: Readonly<Record<QualityTier, number | readonly [number, number]>> = {
  high: [1, 2],
  low: 1,
};

export function tierDpr(tier: QualityTier, devicePixelRatio: number): number {
  const range = TIER_DPR[tier];
  if (typeof range === 'number') return range;
  const value = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(range[1], Math.max(range[0], value));
}

import type { PrismPipelineMode } from "../../types";

// Keep display-space values aligned with --home-page-background in
// hero-theme.css. The presentation shaders blend after tone mapping.
const LIGHT_PAGE_BACKGROUND = 250 / 255;
const OPACITY_REVEAL_SECONDS = 1;
const BEAM_REVEAL_END_SECONDS = 2.5;
const BEAM_REVEAL_START_OPACITY = 0.25;
const BEAM_REVEAL_START_SECONDS =
  OPACITY_REVEAL_SECONDS *
  (1 - Math.cbrt(1 - BEAM_REVEAL_START_OPACITY));

const PAGE_BACKGROUND_SRGB = {
  dark: [0, 0, 0],
  light: [LIGHT_PAGE_BACKGROUND, LIGHT_PAGE_BACKGROUND, LIGHT_PAGE_BACKGROUND],
} as const satisfies Record<
  PrismPipelineMode,
  readonly [number, number, number]
>;

/** Uniforms shared by each theme's final display-encoded reveal. */
export function presentationRevealUniforms(
  mode: PrismPipelineMode,
  progress = 1
): {
  readonly backgroundColor: readonly [number, number, number];
  readonly revealProgress: number;
} {
  return {
    backgroundColor: PAGE_BACKGROUND_SRGB[mode],
    revealProgress: Math.min(1, Math.max(0, progress)),
  };
}

/** Independent display-opacity and beam-aperture timing for the hero intro. */
export function heroRevealProgress(elapsedSeconds: number): {
  readonly opacity: number;
  readonly beamWidth: number;
} {
  const opacityLinear = clamp01(elapsedSeconds / OPACITY_REVEAL_SECONDS);
  const opacity = 1 - (1 - opacityLinear) ** 3;
  const beamLinear = clamp01(
    (elapsedSeconds - BEAM_REVEAL_START_SECONDS) /
      (BEAM_REVEAL_END_SECONDS - BEAM_REVEAL_START_SECONDS)
  );
  return {
    opacity,
    beamWidth: 1 - (1 - beamLinear) ** 3,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

import {
  type HoverDeployAnimationState,
  type LedTransitionFrame,
} from './led-buffer';
import {
  type BrushState,
  type SceneTunables,
} from './light-sources-pass';
import {
  BRIGHTNESS_MIN_HOVER_MULTIPLIER,
  BRIGHTNESS_MIN_HOVER_SMOOTHING,
  DARK_FLOOR_DEFAULTS,
  DARK_POSTPROCESS_DEFAULTS,
  DEFAULT_BRUSH,
  HERO_STATE_DEFAULTS,
  HERO_STATE_MODES,
  HOVER_RGB_TINT_DEFAULTS,
  LIGHT_AO_DEFAULTS,
  LIGHT_GLOW_DEFAULTS,
  PROBE_DISCARD_DEFAULTS,
  RADIANCE_DEBUG_DEFAULTS,
  TUNABLE_DEFAULTS,
  assignDarkFloorSettings,
  type DarkFloorSettings,
  type DarkPostprocessSettings,
  type HeroStateMode,
  type HeroStateSettings,
  type HoverRgbTintSettings,
  type LightAoSettings,
  type LightGlowSettings,
  type ProbeDiscardSettings,
  type RadianceDebugSettings,
} from './settings';

export type FrameTheme = 'dark' | 'light';

/**
 * Per-frame inputs the renderer hands to {@link HeroFrameState.resolveFrame}. These are the raw,
 * caller-supplied partials (brush patch, tunables, render options) plus the device-specific LED
 * upload seam. resolveFrame merges them over defaults, advances the smoothed hover/transition
 * state, runs the shared LED simulation through `updateLedsFor`, and returns the resolved settings
 * the renderer feeds into its GPU encode.
 */
export interface ResolveFrameArgs {
  /** Caller brush patch overlaid on the per-frame off-screen/inactive reset. */
  patch?: Partial<BrushState>;
  /** Caller scene tunables overlaid on TUNABLE_DEFAULTS. */
  tunables?: SceneTunables;
  /** Render options carrying the hero/floor/AO/glow/tint partials. */
  options?: ResolveFrameOptions;
  /** Probe-discard partial overlaid on PROBE_DISCARD_DEFAULTS. */
  probeDiscard?: Partial<ProbeDiscardSettings>;
  /** Active theme — gates the LED color tint and the brightness floor base. */
  theme: FrameTheme;
  /** Monotonic seconds for this frame. */
  time: number;
  /**
   * Device-specific seam: run the shared `computeLeds` against the renderer's LED state, then upload
   * the result to the backend storage (WebGPU: writeBuffer; WebGL: texSubImage). Returns the LED
   * transition frame so resolveFrame can drive the hero-light-param crossfade.
   */
  updateLedsFor(ctx: UpdateLedsContext): LedTransitionFrame;
}

export interface ResolveFrameOptions {
  hero?: Partial<HeroStateSettings>;
  lightAo?: Partial<LightAoSettings>;
  lightGlow?: Partial<LightGlowSettings>;
  radianceDebug?: Partial<RadianceDebugSettings>;
  darkFloor?: Partial<DarkFloorSettings>;
  darkPostprocess?: Partial<DarkPostprocessSettings>;
  hoverRgbTint?: Partial<HoverRgbTintSettings>;
  hoverRgbDeployActive?: boolean;
}

/** The fully-resolved per-frame LED simulation inputs the renderer's `updateLedsFor` seam runs. */
export interface UpdateLedsContext {
  time: number;
  tunables: SceneTunables;
  settings: HeroStateSettings;
  hoverDeploy: HoverDeployAnimationState;
  brush: BrushState;
  theme: FrameTheme;
}

/**
 * The resolved per-frame state the renderer encodes. The settings objects are reused scratch
 * instances owned by the frame state (no per-frame allocation), so the renderer must consume them
 * synchronously within the same frame.
 */
export interface ResolvedFrame {
  brush: BrushState;
  tunables: SceneTunables;
  hero: HeroStateSettings;
  probeDiscard: ProbeDiscardSettings;
  lightAo: LightAoSettings;
  lightGlow: LightGlowSettings;
  radianceDebug: RadianceDebugSettings;
  darkFloor: DarkFloorSettings;
  darkPostprocess: DarkPostprocessSettings;
  hoverRgbTint: HoverRgbTintSettings;
  /** White↔color blend for the light floor tint, driven by the deploy factor. */
  colorMix: number;
}

export interface HeroFrameState {
  resolveFrame(args: ResolveFrameArgs): ResolvedFrame;
}

// Reset the brush off-screen/inactive each frame before the per-frame `patch` overlays it. Hoisted to
// a module const (used only as an Object.assign source, so it's never mutated) to avoid allocating this
// literal on every resolveFrame() call.
const BRUSH_RESET = Object.freeze({
  x: -1000,
  y: -1000,
  active: false,
  inside: false,
  isMouse: false,
});

// CPU half of the per-theme encoders: how the deploy/hover RGB tint amount resolves per theme.
// Dark clamps the configured amount; light zeroes it (the floor material colors the light instead,
// driven by colorMix), while the deploy factor still ramps and drives the floor's white↔color blend.
function adjustHoverTint(
  settings: HoverRgbTintSettings,
  theme: FrameTheme,
): void {
  if (theme === 'light') {
    settings.amount = 0;
  } else {
    settings.amount = clamp01(settings.amount);
  }
}

/**
 * Owns the smoothed, frame-to-frame hero animation state (LED-intensity / brightness-max crossfade,
 * hover-tint response, deploy timing, and the hover brightness-min floor) plus the reusable scratch
 * settings objects. `resolveFrame` is the single device-agnostic entry the WebGPU and WebGL
 * renderers share — it produces the resolved per-frame inputs and runs the LED simulation through
 * the supplied `updateLedsFor` seam, leaving each backend to own only its GPU/upload specifics.
 */
export function createHeroFrameState(): HeroFrameState {
  let heroLightParamsInitialized = false;
  let heroLightParamsTransitionActive = false;
  let heroLightParamsFromBrightnessMax = 0;
  let heroLightParamsTargetBrightnessMax = 0;
  let heroLightParamsVisibleBrightnessMax = 0;
  let heroLightParamsFromLedIntensity = 0;
  let heroLightParamsTargetLedIntensity = 0;
  let heroLightParamsVisibleLedIntensity = 0;
  let hoverTintResponseInitialized = false;
  let hoverTintResponseLastTime = 0;
  let hoverTintResponseValue = 0;
  let hoverDeployRawActive = false;
  let hoverDeployStartTime = 0;
  let hoverDeployElapsed = 0;
  let brightnessMinHoverInitialized = false;
  let brightnessMinHoverLastTime = 0;
  let brightnessMinHoverValue = 0;

  const currentBrush: BrushState = {
    ...DEFAULT_BRUSH,
    x: -1000,
    y: -1000,
    active: false,
  };
  const currentTunables: SceneTunables = { ...TUNABLE_DEFAULTS };
  const currentHero: HeroStateSettings = { ...HERO_STATE_DEFAULTS };
  const currentProbeDiscard: ProbeDiscardSettings = {
    ...PROBE_DISCARD_DEFAULTS,
  };
  const currentLightAo: LightAoSettings = { ...LIGHT_AO_DEFAULTS };
  const currentLightGlow: LightGlowSettings = { ...LIGHT_GLOW_DEFAULTS };
  const currentRadianceDebug: RadianceDebugSettings = {
    ...RADIANCE_DEBUG_DEFAULTS,
  };
  const currentDarkFloor: DarkFloorSettings = { ...DARK_FLOOR_DEFAULTS };
  const currentDarkPostprocess: DarkPostprocessSettings = {
    ...DARK_POSTPROCESS_DEFAULTS,
  };
  const currentHoverRgbTint: HoverRgbTintSettings = {
    ...HOVER_RGB_TINT_DEFAULTS,
  };

  const updateHeroLightParams = (
    ledTransition: LedTransitionFrame,
    targetLedIntensity: number,
    targetBrightnessMax: number,
  ) => {
    if (!heroLightParamsInitialized) {
      heroLightParamsInitialized = true;
      heroLightParamsTransitionActive = false;
      heroLightParamsFromLedIntensity = targetLedIntensity;
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsVisibleLedIntensity = targetLedIntensity;
      heroLightParamsFromBrightnessMax = targetBrightnessMax;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsVisibleBrightnessMax = targetBrightnessMax;
      return;
    }

    if (ledTransition.modeChanged) {
      heroLightParamsFromLedIntensity = heroLightParamsVisibleLedIntensity;
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsFromBrightnessMax = heroLightParamsVisibleBrightnessMax;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsTransitionActive = ledTransition.progress < 1;
    } else if (!heroLightParamsTransitionActive) {
      heroLightParamsTargetLedIntensity = targetLedIntensity;
      heroLightParamsVisibleLedIntensity = targetLedIntensity;
      heroLightParamsTargetBrightnessMax = targetBrightnessMax;
      heroLightParamsVisibleBrightnessMax = targetBrightnessMax;
      return;
    }

    if (heroLightParamsTransitionActive) {
      heroLightParamsVisibleLedIntensity = mix(
        heroLightParamsFromLedIntensity,
        heroLightParamsTargetLedIntensity,
        ledTransition.easedProgress,
      );
      heroLightParamsVisibleBrightnessMax = mix(
        heroLightParamsFromBrightnessMax,
        heroLightParamsTargetBrightnessMax,
        ledTransition.easedProgress,
      );
      if (ledTransition.progress >= 1) heroLightParamsTransitionActive = false;
    } else {
      heroLightParamsVisibleLedIntensity = heroLightParamsTargetLedIntensity;
      heroLightParamsVisibleBrightnessMax = heroLightParamsTargetBrightnessMax;
    }
  };

  const updateHoverTintResponse = (
    target: number,
    currentTime: number,
    // One smoothing for BOTH directions, so grayscale→color and color→grayscale take the same
    // time (the grayscale→color feel applied to both).
    responseSmoothing: number,
  ) => {
    const clampedTarget = clamp01(target);
    if (!hoverTintResponseInitialized) {
      hoverTintResponseInitialized = true;
      hoverTintResponseLastTime = currentTime;
      hoverTintResponseValue = clampedTarget;
      return hoverTintResponseValue;
    }

    const rawDt = currentTime - hoverTintResponseLastTime;
    hoverTintResponseLastTime = currentTime;
    if (responseSmoothing <= 0 || !Number.isFinite(responseSmoothing)) {
      hoverTintResponseValue = clampedTarget;
      return hoverTintResponseValue;
    }

    const dt = Math.min(0.25, Math.max(0, Number.isFinite(rawDt) ? rawDt : 0));
    const alpha = 1 - Math.exp(-dt / responseSmoothing);
    hoverTintResponseValue = mix(hoverTintResponseValue, clampedTarget, alpha);
    if (Math.abs(hoverTintResponseValue - clampedTarget) < 0.0001) {
      hoverTintResponseValue = clampedTarget;
    }
    return hoverTintResponseValue;
  };

  const updateBrightnessMinHover = (
    target: number,
    currentTime: number,
    responseSmoothing: number,
  ) => {
    if (!brightnessMinHoverInitialized) {
      brightnessMinHoverInitialized = true;
      brightnessMinHoverLastTime = currentTime;
      brightnessMinHoverValue = target;
      return brightnessMinHoverValue;
    }

    const rawDt = currentTime - brightnessMinHoverLastTime;
    brightnessMinHoverLastTime = currentTime;
    if (responseSmoothing <= 0 || !Number.isFinite(responseSmoothing)) {
      brightnessMinHoverValue = target;
      return brightnessMinHoverValue;
    }

    const dt = Math.min(0.25, Math.max(0, Number.isFinite(rawDt) ? rawDt : 0));
    const alpha = 1 - Math.exp(-dt / responseSmoothing);
    brightnessMinHoverValue = mix(brightnessMinHoverValue, target, alpha);
    if (Math.abs(brightnessMinHoverValue - target) < 0.0001) {
      brightnessMinHoverValue = target;
    }
    return brightnessMinHoverValue;
  };

  const resolveFrame = (args: ResolveFrameArgs): ResolvedFrame => {
    const {
      patch,
      tunables,
      options,
      probeDiscard,
      theme,
      time,
      updateLedsFor,
    } = args;
    const currentTime = time;
    Object.assign(currentBrush, DEFAULT_BRUSH, BRUSH_RESET, patch);
    Object.assign(currentTunables, TUNABLE_DEFAULTS, tunables);
    Object.assign(currentHero, HERO_STATE_DEFAULTS, options?.hero);
    Object.assign(currentProbeDiscard, PROBE_DISCARD_DEFAULTS, probeDiscard);
    Object.assign(currentLightAo, LIGHT_AO_DEFAULTS, options?.lightAo);
    Object.assign(currentLightGlow, LIGHT_GLOW_DEFAULTS, options?.lightGlow);
    Object.assign(
      currentRadianceDebug,
      RADIANCE_DEBUG_DEFAULTS,
      options?.radianceDebug,
    );
    assignDarkFloorSettings(currentDarkFloor, options?.darkFloor);
    Object.assign(
      currentDarkPostprocess,
      DARK_POSTPROCESS_DEFAULTS,
      options?.darkPostprocess,
    );
    Object.assign(
      currentHoverRgbTint,
      HOVER_RGB_TINT_DEFAULTS,
      options?.hoverRgbTint,
    );
    adjustHoverTint(currentHoverRgbTint, theme);
    const hoverDeployActive =
      currentHoverRgbTint.enabled && options?.hoverRgbDeployActive === true;
    if (hoverDeployActive && !hoverDeployRawActive) {
      hoverDeployStartTime = currentTime;
      hoverDeployElapsed = 0;
    }
    hoverDeployRawActive = hoverDeployActive;
    if (hoverDeployActive) {
      hoverDeployElapsed = Math.max(0, currentTime - hoverDeployStartTime);
    }
    const hoverTintFactor = updateHoverTintResponse(
      hoverDeployActive ? 1 : 0,
      currentTime,
      currentHoverRgbTint.responseSmoothing,
    );
    // Lift the noise brightness floor while the pointer hovers the triangle, easing back to the
    // configured default once it leaves. On hover the floor eases toward base ×
    // BRIGHTNESS_MIN_HOVER_MULTIPLIER (relative, so it tracks retuned base values). Dark uses
    // brightnessMinDark; light uses brightnessMin but drops the floor to 0 while the shader is
    // grayscale-only, ramping it back in with the color mix.
    const baseBrightnessMin =
      theme === 'dark'
        ? currentTunables.brightnessMinDark
        : currentTunables.brightnessMin * hoverTintFactor;
    currentTunables.brightnessMin = updateBrightnessMinHover(
      currentBrush.active && currentBrush.inside === true
        ? baseBrightnessMin * BRIGHTNESS_MIN_HOVER_MULTIPLIER
        : baseBrightnessMin,
      currentTime,
      BRIGHTNESS_MIN_HOVER_SMOOTHING,
    );
    const ledTransition = updateLedsFor({
      time: currentTime,
      tunables: currentTunables,
      settings: currentHero,
      hoverDeploy: {
        factor: hoverTintFactor,
        elapsed: hoverDeployElapsed,
        time: currentTime,
        tint: currentHoverRgbTint,
      },
      brush: currentBrush,
      theme,
    });
    updateHeroLightParams(
      ledTransition,
      currentTunables.ledIntensity,
      heroBrightnessMaxForMode(
        currentHero.mode,
        theme === 'light'
          ? currentTunables.brightnessMaxLight
          : currentTunables.brightnessMax,
      ),
    );
    currentTunables.ledIntensity = heroLightParamsVisibleLedIntensity;
    currentTunables.brightnessMax = heroLightParamsVisibleBrightnessMax;

    return {
      brush: currentBrush,
      tunables: currentTunables,
      hero: currentHero,
      probeDiscard: currentProbeDiscard,
      lightAo: currentLightAo,
      lightGlow: currentLightGlow,
      radianceDebug: currentRadianceDebug,
      darkFloor: currentDarkFloor,
      darkPostprocess: currentDarkPostprocess,
      hoverRgbTint: currentHoverRgbTint,
      // White↔color blend for the light floor tint, driven by the deploy factor.
      // Dark mode ignores it (only the light floor reads colorMix).
      colorMix: hoverTintFactor,
    };
  };

  return { resolveFrame };
}

function heroBrightnessMaxForMode(
  mode: HeroStateMode,
  baseBrightnessMax: number,
) {
  if (mode === HERO_STATE_MODES.scan) return 1;
  if (mode === HERO_STATE_MODES.pulse) return 0.5;
  // coding / edge / lines drive coverage across the full [0,1] band, so they keep the
  // optically-tuned theme brightnessMax (dark/light) — a band's center reaches it, the
  // gaps fall to brightnessMin.
  return baseBrightnessMax;
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

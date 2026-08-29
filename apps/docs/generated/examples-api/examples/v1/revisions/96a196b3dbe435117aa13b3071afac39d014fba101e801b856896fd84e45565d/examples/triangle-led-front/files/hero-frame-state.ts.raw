import type { HoverDeployAnimationState } from './led-buffer';
import {
  BRIGHTNESS_MIN_HOVER_MULTIPLIER,
  BRIGHTNESS_MIN_HOVER_SMOOTHING,
  DEFAULT_BRUSH,
  HERO_STATE_DEFAULTS,
  HOVER_RGB_TINT_DEFAULTS,
  TUNABLE_DEFAULTS,
  type BrushState,
  type HeroStateSettings,
  type SceneTunables,
} from './settings';

export interface UpdateLedsContext {
  time: number;
  tunables: SceneTunables;
  settings: HeroStateSettings;
  hoverDeploy: HoverDeployAnimationState;
  brush: BrushState;
}

interface ResolveFrameArgs {
  patch?: Partial<BrushState>;
  hero?: Partial<HeroStateSettings>;
  hoverRgbDeployActive: boolean;
  time: number;
  updateLedsFor(ctx: UpdateLedsContext): void;
}

interface Smoother {
  initialized: boolean;
  lastTime: number;
  value: number;
}

const BRUSH_RESET = {
  x: -1000,
  y: -1000,
  active: false,
  inside: false,
  isMouse: false,
};

export function createHeroFrameState() {
  const deploy: Smoother = { initialized: false, lastTime: 0, value: 0 };
  const brightness: Smoother = { initialized: false, lastTime: 0, value: 0 };
  const brush: BrushState = {
    ...DEFAULT_BRUSH,
    x: -1000,
    y: -1000,
    active: false,
  };
  const tunables: SceneTunables = { ...TUNABLE_DEFAULTS };
  const hero: HeroStateSettings = { ...HERO_STATE_DEFAULTS };

  return {
    resolveFrame(args: ResolveFrameArgs) {
      const { time } = args;
      Object.assign(brush, DEFAULT_BRUSH, BRUSH_RESET, args.patch);
      Object.assign(tunables, TUNABLE_DEFAULTS);
      Object.assign(hero, HERO_STATE_DEFAULTS, args.hero);
      const deployFactor = smooth(
        deploy,
        HOVER_RGB_TINT_DEFAULTS.enabled && args.hoverRgbDeployActive ? 1 : 0,
        time,
        HOVER_RGB_TINT_DEFAULTS.responseSmoothing,
      );
      const baseBrightness = tunables.brightnessMinDark;
      tunables.brightnessMin = smooth(
        brightness,
        brush.active && brush.inside === true
          ? baseBrightness * BRIGHTNESS_MIN_HOVER_MULTIPLIER
          : baseBrightness,
        time,
        BRIGHTNESS_MIN_HOVER_SMOOTHING,
      );
      args.updateLedsFor({
        time,
        tunables,
        settings: hero,
        hoverDeploy: { factor: deployFactor, tint: HOVER_RGB_TINT_DEFAULTS },
        brush,
      });
      return { tunables };
    },
  };
}

function smooth(
  state: Smoother,
  target: number,
  time: number,
  smoothing: number,
) {
  if (!state.initialized) {
    state.initialized = true;
    state.lastTime = time;
    state.value = target;
    return state.value;
  }
  const rawDt = time - state.lastTime;
  state.lastTime = time;
  if (smoothing <= 0 || !Number.isFinite(smoothing)) {
    state.value = target;
    return state.value;
  }
  const dt = Math.min(0.25, Math.max(0, Number.isFinite(rawDt) ? rawDt : 0));
  const alpha = 1 - Math.exp(-dt / smoothing);
  state.value = state.value + (target - state.value) * alpha;
  if (Math.abs(state.value - target) < 0.0001) state.value = target;
  return state.value;
}

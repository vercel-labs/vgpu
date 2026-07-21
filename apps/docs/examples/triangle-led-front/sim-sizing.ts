import {
  HERO_STATE_DEFAULTS,
  HERO_STATE_MODES,
  type BrushSettings,
  type HeroStateMode,
  type HeroStateSettings,
  simulationFloorFactor,
} from './settings';

export interface CanvasRenderSizing {
  simulationWidth: number;
  simulationHeight: number;
  pixelRatio: number;
  probeDensity: number;
  cascadeCount?: number;
}

export interface WorkerPointerState {
  x: number;
  y: number;
  active: boolean;
  inside?: boolean;
  isMouse?: boolean;
}

export interface WorkerBrushState extends BrushSettings {
  x: number;
  y: number;
  active: boolean;
  inside: boolean;
  isMouse: boolean;
}

export function canvasRenderSizing(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  probeDensity: number,
  cascadeCount: number | undefined,
): CanvasRenderSizing {
  const factor = simulationFloorFactor(cssHeight);
  const sizing: CanvasRenderSizing = {
    simulationWidth: cssWidth * factor,
    simulationHeight: cssHeight * factor,
    pixelRatio: dpr,
    probeDensity,
  };

  if (cascadeCount !== undefined) {
    sizing.cascadeCount = cascadeCount;
  }

  return sizing;
}

export function brushState(
  brush: BrushSettings,
  pointer?: Pick<
    WorkerPointerState,
    'x' | 'y' | 'active' | 'inside' | 'isMouse'
  >,
): WorkerBrushState {
  if (!pointer || !pointer.active) {
    return {
      ...brush,
      x: -1000,
      y: -1000,
      active: false,
      inside: false,
      isMouse: false,
    };
  }

  return {
    ...brush,
    x: pointer.x,
    y: pointer.y,
    active: true,
    inside: pointer.inside ?? false,
    isMouse: pointer.isMouse ?? false,
  };
}

export function simulationBrushState(
  brush: BrushSettings,
  pointer: Pick<WorkerPointerState, 'x' | 'y' | 'active' | 'inside' | 'isMouse'>,
  cssHeight: number,
): WorkerBrushState {
  const factor = simulationFloorFactor(cssHeight);
  return brushState(brush, {
    ...pointer,
    x: pointer.x * factor,
    y: pointer.y * factor,
  });
}

export const ACCORDION_EDGE_INDEX_BY_ACTIVE_CLICK = [0, 2, 1] as const;

type ActiveClickHeroState = {
  mode: Extract<HeroStateMode, 'edge' | 'lines'>;
  edgeIndex: HeroStateSettings['edgeIndex'];
};

export function heroStateForActiveClick(
  activeClick: number,
): ActiveClickHeroState {
  if (activeClick === 0 || activeClick === 1 || activeClick === 2) {
    const edgeIndex = ACCORDION_EDGE_INDEX_BY_ACTIVE_CLICK[activeClick];
    return { mode: HERO_STATE_MODES.edge, edgeIndex };
  }

  return {
    mode: HERO_STATE_MODES.lines,
    edgeIndex: HERO_STATE_DEFAULTS.edgeIndex,
  };
}

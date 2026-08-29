import {
  HERO_STATE_DEFAULTS,
  HERO_STATE_MODES,
  simulationFloorFactor,
  type BrushSettings,
  type BrushState,
} from './settings';

interface PointerState {
  x: number;
  y: number;
  active: boolean;
  inside?: boolean;
  isMouse?: boolean;
}

export function canvasRenderSizing(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
) {
  const factor = simulationFloorFactor(cssHeight);
  return {
    simulationWidth: cssWidth * factor,
    simulationHeight: cssHeight * factor,
    pixelRatio: dpr,
  };
}

export function brushState(
  brush: BrushSettings,
  pointer?: PointerState,
): BrushState {
  if (!pointer?.active) {
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
  pointer: PointerState,
  cssHeight: number,
) {
  const factor = simulationFloorFactor(cssHeight);
  return brushState(brush, {
    ...pointer,
    x: pointer.x * factor,
    y: pointer.y * factor,
  });
}

const EDGE_BY_CONTROL = [0, 2, 1] as const;

export function heroStateForActiveClick(activeClick: number) {
  if (activeClick === 0 || activeClick === 1 || activeClick === 2) {
    return { mode: HERO_STATE_MODES.edge, edgeIndex: EDGE_BY_CONTROL[activeClick] };
  }
  return {
    mode: HERO_STATE_MODES.lines,
    edgeIndex: HERO_STATE_DEFAULTS.edgeIndex,
  };
}

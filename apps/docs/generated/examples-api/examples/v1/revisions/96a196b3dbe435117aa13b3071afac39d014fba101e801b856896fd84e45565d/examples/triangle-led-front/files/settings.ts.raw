export interface RenderSize {
  width: number;
  height: number;
}

export const LEDS_PER_EDGE = 24;
export const TRIANGLE_HEIGHT_RATIO = (180 / 630) * 0.8;
export const HERO_CANVAS_MAX_CSS = 720;
const MIN_SIM_HEIGHT = 360;
const LED_RADIUS_TO_TRIANGLE_HEIGHT = 0.0236;
const LED_NORMAL_HALF_THICKNESS_TO_RADIUS = 2;
const LED_TANGENT_GAP_PX = 1;
const LED_CORNER_TRIM_EPSILON_PX = 1;
const LED_MESH_INSET_PX = 5;

export const LED_SDF_CROP_EXPANSION_PX = 2;
export const LED_EMITTER_MESH_EXPANSION_PX = 1;
export const NOISE_ROTATION_START_SECONDS = 10;
export const BRIGHTNESS_MIN_HOVER_MULTIPLIER = 4;
export const BRIGHTNESS_MIN_HOVER_SMOOTHING = 0.2;

export const HERO_STATE_MODES = {
  edge: 'edge',
  lines: 'lines',
} as const;
export type HeroStateMode =
  (typeof HERO_STATE_MODES)[keyof typeof HERO_STATE_MODES];

export interface HeroStateSettings {
  mode: HeroStateMode;
  transitionDuration: number;
  edgeIndex: number;
  edgeHighlightBrightness: number;
}

export const HERO_STATE_DEFAULTS: HeroStateSettings = {
  mode: HERO_STATE_MODES.lines,
  transitionDuration: 0.25,
  edgeIndex: 0,
  edgeHighlightBrightness: 0.4,
};

export interface BrushSettings {
  glowEnabled?: boolean;
  glowRadius?: number;
  glowStrength?: number;
  glowSmoothing?: number;
  glowFacingEnabled?: boolean;
  glowFacingFullDeg?: number;
  glowFacingZeroDeg?: number;
  linesFadeDistance?: number;
}

export interface BrushState extends BrushSettings {
  x: number;
  y: number;
  active: boolean;
  inside?: boolean;
  isMouse?: boolean;
}

export interface SceneTunables {
  ledIntensity: number;
  brightnessMin: number;
  brightnessMinDark: number;
  brightnessMax: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  glowEnabled: true,
  glowRadius: 165,
  glowStrength: 1,
  glowSmoothing: 0.23,
  glowFacingEnabled: true,
  glowFacingFullDeg: 90,
  glowFacingZeroDeg: 100,
  linesFadeDistance: 0.6,
};

export const TUNABLE_DEFAULTS = {
  ledIntensity: 1,
  brightnessMin: 0.09,
  brightnessMinDark: 0.05,
  brightnessMax: 1,
} as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface HoverRgbTintSettings {
  enabled: boolean;
  amount: number;
  radius: number;
  power: number;
  responseSmoothing: number;
  edgeRedLinear: Rgb;
  edgeGreenLinear: Rgb;
  edgeBlueLinear: Rgb;
  edgeOverlap: number;
}

export const HOVER_RGB_TINT_DEFAULTS: HoverRgbTintSettings = {
  enabled: true,
  amount: 1,
  radius: 173,
  power: 3,
  responseSmoothing: 0.2,
  edgeRedLinear: { r: 0.896269, g: 0.027321, b: 0.051269 },
  edgeGreenLinear: { r: 0, g: 0.40724, b: 0.048172 },
  edgeBlueLinear: { r: 0, g: 0.278894, b: 1 },
  edgeOverlap: 1,
};

export function simulationFloorFactor(cssHeight: number) {
  return Math.max(1, MIN_SIM_HEIGHT / Math.max(1, cssHeight));
}

interface LedPosition {
  x: number;
  y: number;
  angle?: number;
}

export interface TriangleGeometry {
  center: LedPosition;
  top: LedPosition;
  left: LedPosition;
  right: LedPosition;
  height: number;
  circumradius: number;
  inradius: number;
  sideLength: number;
}

interface TriangleLedShape {
  normalHalfThickness: number;
  tangentHalfLength: number;
  cornerTrim: number;
  centerSpacing: number;
}

export interface TriangleLayout {
  center: LedPosition;
  positions: LedPosition[];
  geometry: TriangleGeometry;
  ledShape: TriangleLedShape;
}

let heroSceneScale = 1;

export function setHeroSceneScale(scale: number) {
  heroSceneScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function resolveHeroSceneScale(
  baseZoom: number,
  cssHeight: number,
  mobile = false,
) {
  if (mobile) return baseZoom;
  if (!Number.isFinite(cssHeight) || cssHeight <= 0) return baseZoom;
  return baseZoom * Math.min(1, 560 / cssHeight);
}

export function canonicalTriangleGeometry(size: RenderSize): TriangleGeometry {
  const height = size.height * TRIANGLE_HEIGHT_RATIO * heroSceneScale;
  const circumradius = (height * 2) / 3;
  const inradius = height / 3;
  const sideLength = (height * 2) / Math.sqrt(3);
  const cx = size.width * 0.5;
  const cy = size.height * 0.5;
  const center = { x: cx, y: cy };
  const top = { x: cx, y: cy - circumradius };
  const left = { x: cx - sideLength * 0.5, y: cy + inradius };
  const right = { x: cx + sideLength * 0.5, y: cy + inradius };
  return {
    center,
    top,
    left,
    right,
    height,
    circumradius,
    inradius,
    sideLength,
  };
}

function triangleLedRadius(size: RenderSize) {
  return canonicalTriangleGeometry(size).height * LED_RADIUS_TO_TRIANGLE_HEIGHT;
}

function triangleLedNormalHalfThickness(size: RenderSize) {
  return triangleLedRadius(size) * LED_NORMAL_HALF_THICKNESS_TO_RADIUS;
}

function triangleLedCornerTrim(size: RenderSize) {
  const rawTrim =
    triangleLedNormalHalfThickness(size) * Math.sqrt(3) +
    LED_CORNER_TRIM_EPSILON_PX;
  const sideLength = canonicalTriangleGeometry(size).sideLength;
  return Math.min(rawTrim, sideLength * 0.45);
}

function triangleLedShapeDimensions(
  size: RenderSize,
  perEdge: number,
): TriangleLedShape {
  const geometry = canonicalTriangleGeometry(size);
  const cornerTrim = triangleLedCornerTrim(size);
  const trimmedSideLength = Math.max(0, geometry.sideLength - cornerTrim * 2);
  const centerSpacing = trimmedSideLength / Math.max(1, perEdge);
  const normalHalfThickness = triangleLedNormalHalfThickness(size);
  const tangentHalfLength = Math.max(
    0,
    centerSpacing * 0.5 - LED_TANGENT_GAP_PX * 0.5,
  );
  return {
    normalHalfThickness,
    tangentHalfLength,
    cornerTrim,
    centerSpacing,
  };
}

function scaleTriangleGeometry(
  geometry: TriangleGeometry,
  scale: number,
): TriangleGeometry {
  const center = geometry.center;
  const toward = (point: LedPosition) => ({
    x: center.x + (point.x - center.x) * scale,
    y: center.y + (point.y - center.y) * scale,
  });
  return {
    center,
    top: toward(geometry.top),
    left: toward(geometry.left),
    right: toward(geometry.right),
    height: geometry.height * scale,
    circumradius: geometry.circumradius * scale,
    inradius: geometry.inradius * scale,
    sideLength: geometry.sideLength * scale,
  };
}

function ledMeshScale(base: TriangleGeometry) {
  const refHeight = HERO_CANVAS_MAX_CSS * TRIANGLE_HEIGHT_RATIO;
  const inset =
    (LED_MESH_INSET_PX * Math.min(base.height, refHeight)) / refHeight;
  return base.inradius > inset ? (base.inradius - inset) / base.inradius : 1;
}

export function ledMeshGeometry(size: RenderSize) {
  const base = canonicalTriangleGeometry(size);
  return scaleTriangleGeometry(base, ledMeshScale(base));
}

export function triangleEdgeLedLayout(
  size: RenderSize,
  perEdge: number,
): TriangleLayout {
  const base = canonicalTriangleGeometry(size);
  const meshScale = ledMeshScale(base);
  const geometry = scaleTriangleGeometry(base, meshScale);
  const { top, left, right, center } = geometry;
  const edges = [
    [top, left],
    [left, right],
    [right, top],
  ] as const;
  const ledSize = { width: size.width, height: size.height * meshScale };
  const ledShape = triangleLedShapeDimensions(ledSize, perEdge);
  const positions: LedPosition[] = [];
  for (const [a, b] of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const edgeLength = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const trimT = edgeLength > 0 ? ledShape.cornerTrim / edgeLength : 0;
    const slotT = edgeLength > 0 ? ledShape.centerSpacing / edgeLength : 0;
    for (let i = 0; i < perEdge; i++) {
      const t = trimT + (i + 0.5) * slotT;
      positions.push({ x: a.x + dx * t, y: a.y + dy * t, angle });
    }
  }
  return { center, positions, geometry, ledShape };
}

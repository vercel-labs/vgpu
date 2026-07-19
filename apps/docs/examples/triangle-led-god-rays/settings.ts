export interface RenderSize {
  width: number;
  height: number;
}

export interface CascadeFitRect extends RenderSize {
  /** Cascade-pixel-space origin inside the full, unfitted cascade texture. */
  originX: number;
  originY: number;
  fullWidth: number;
  fullHeight: number;
  alignment: number;
  areaRatio: number;
  /** Scene-space origin/size represented by the fitted cascade texture. */
  originSceneX: number;
  originSceneY: number;
  widthScene: number;
  heightScene: number;
}

export const CASCADE0_DIMS = 2;
/**
 * Doubles spatial probe density by scaling cascade texture size without
 * changing CASCADE0_DIMS or angular samples per probe.
 * K=2 means 2x probes per axis / ~4x total probes.
 */
export const PROBE_DENSITY = 2;
export const PROBE_DENSITY_MIN = 1;
export const PROBE_DENSITY_MAX = 3;
export const CASCADE0_RANGE = 1;
export const CASCADE_FACTOR = 4;
/**
 * Experimental far-cascade cap for PR #47. For 1920x1080-like sizes the
 * uncapped diagonal-based cascade count reaches levels 0..6. Capping at four
 * cascades (0..3) removed too much far-field glow in dark snapshots, so this
 * safer cap keeps levels 0..4 and skips only the most distant levels 5..6.
 */
export const MAX_CASCADE_COUNT = 5;
export const TRIANGLE_AABB_PROBES_Y = 8;
export const LAZY_RADIUS = 60;
export const LEDS_PER_EDGE = 24;
export const TRIANGLE_HEIGHT_RATIO = 0.3;
export const LED_RADIUS_TO_TRIANGLE_HEIGHT = 0.0236;
export const LED_COLOR = { r: 16, g: 16, b: 16 } as const;

export const HERO_STATE_MODES = {
  coding: 'coding',
  scan: 'scan',
  pulse: 'pulse',
} as const;

export type HeroStateMode =
  (typeof HERO_STATE_MODES)[keyof typeof HERO_STATE_MODES];

export interface HeroStateSettings {
  mode: HeroStateMode;
  transitionDuration: number;
  scanSpeed: number;
  scanHeadWidth: number;
  scanRedShift: number;
  scanBlueShift: number;
  scanHueRotationSpeed: number;
  pulseSpeed: number;
  pulseWidth: number;
}

export const HERO_STATE_DEFAULTS: HeroStateSettings = {
  mode: HERO_STATE_MODES.coding,
  transitionDuration: 0.4,
  scanSpeed: 0.08,
  scanHeadWidth: 7.5,
  scanRedShift: 0.3,
  scanBlueShift: 0.3,
  scanHueRotationSpeed: 0.03,
  pulseSpeed: 0.25,
  pulseWidth: 4,
};

export const HERO_STATE_RANGES = {
  transitionDuration: { min: 0, max: 2, step: 0.05 },
  scanSpeed: { min: 0.01, max: 1, step: 0.01 },
  scanHeadWidth: { min: 1, max: 12, step: 0.25 },
  scanRedShift: { min: 0, max: 1, step: 0.01 },
  scanBlueShift: { min: 0, max: 1, step: 0.01 },
  scanHueRotationSpeed: { min: 0, max: 0.2, step: 0.005 },
  pulseSpeed: { min: 0.05, max: 2, step: 0.05 },
  pulseWidth: { min: 1, max: 8, step: 0.25 },
} as const;

export function mergeHeroStateSettings(
  patch?: Partial<HeroStateSettings>,
): HeroStateSettings {
  return { ...HERO_STATE_DEFAULTS, ...patch };
}

export interface LedPosition {
  x: number;
  y: number;
  angle?: number;
}
export interface TriangleLayout {
  center: LedPosition;
  positions: LedPosition[];
  geometry: TriangleGeometry;
  ledRadius: number;
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

export interface BrushSettings {
  radius: number;
  friction: number;
  colour: { r: number; g: number; b: number };
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 28,
  friction: 5,
  colour: { r: 1, g: 1, b: 1 },
};

export const TUNABLE_DEFAULTS = {
  floorAlbedo: 0.03,
  ledIntensity: 32.0,
  noiseScale: 0.009,
  rotationSpeed: -0.2,
  brightnessMin: 0,
  brightnessMax: 2.0,
  ledHitThreshold: 1.0,
} as const;

export const TUNABLE_RANGES = {
  floorAlbedo: { min: 0, max: 1, step: 0.01 },
  ledIntensity: { min: 1, max: 64, step: 0.5 },
  noiseScale: { min: 0.001, max: 0.1, step: 0.001 },
  rotationSpeed: { min: -3, max: 3, step: 0.05 },
  brightnessMin: { min: 0, max: 1, step: 0.01 },
  brightnessMax: { min: 0, max: 2, step: 0.01 },
  ledHitThreshold: { min: 0, max: 2, step: 0.01 },
} as const;

export interface ProbeDiscardSettings {
  lightAabbPadding: number;
  probeDiscardDistance: number;
}

export const PROBE_DISCARD_DEFAULTS: ProbeDiscardSettings = {
  lightAabbPadding: 2,
  probeDiscardDistance: 0.4,
};

export const PROBE_DISCARD_RANGES = {
  lightAabbPadding: { min: 0, max: 512, step: 1 },
  probeDiscardDistance: { min: 0, max: 1, step: 0.01 },
} as const;

export function mergeProbeDiscardSettings(
  patch?: Partial<ProbeDiscardSettings>,
): ProbeDiscardSettings {
  return { ...PROBE_DISCARD_DEFAULTS, ...patch };
}

export interface LightAoSettings {
  opacity: number;
  size: number;
}

export const LIGHT_AO_DEFAULTS: LightAoSettings = {
  opacity: 0.2,
  size: 0.75,
};

export const LIGHT_AO_RANGES = {
  opacity: { min: 0, max: 0.6, step: 0.01 },
  size: { min: 0.1, max: 1.5, step: 0.01 },
} as const;

export function mergeLightAoSettings(
  patch?: Partial<LightAoSettings>,
): LightAoSettings {
  return { ...LIGHT_AO_DEFAULTS, ...patch };
}

export interface BloomSettings {
  threshold: number;
  intensity: number;
  sigma: number;
}

export const BLOOM_DEFAULTS: BloomSettings = {
  threshold: 0,
  intensity: 1.7,
  sigma: 2.9,
};

export function mergeBloomSettings(
  patch?: Partial<BloomSettings>,
): BloomSettings {
  return { ...BLOOM_DEFAULTS, ...patch };
}

export interface GodRaySettings {
  enabled: boolean;
  opacity: number;
  intensity: number;
  scale: number;
  stretch: number;
  contrastLo: number;
  contrastHi: number;
  contrastPower: number;
  feather: number;
}

export const GOD_RAY_DEFAULTS: GodRaySettings = {
  enabled: true,
  opacity: 0.03,
  intensity: 0.06,
  scale: 0.95,
  stretch: 0.2,
  contrastLo: 0.08,
  contrastHi: 2,
  contrastPower: 8,
  feather: 3,
};

export const GOD_RAY_RANGES = {
  opacity: { min: 0, max: 1, step: 0.005 },
  intensity: { min: 0, max: 2, step: 0.001 },
  scale: { min: 0, max: 1.8, step: 0.01 },
  stretch: { min: 0, max: 1, step: 0.01 },
  contrastLo: { min: 0, max: 1, step: 0.005 },
  contrastHi: { min: 0, max: 2, step: 0.005 },
  contrastPower: { min: 0.25, max: 8, step: 0.05 },
  feather: { min: 0.01, max: 3, step: 0.01 },
} as const;

export function mergeGodRaySettings(
  patch?: Partial<GodRaySettings>,
): GodRaySettings {
  return { ...GOD_RAY_DEFAULTS, ...patch };
}

export function godRayBoundsExpansion(
  triangleCircumradius: number,
  settings: GodRaySettings,
  extraMargin = 0,
): number {
  if (!settings.enabled) return 0;
  return (
    settings.scale * triangleCircumradius +
    settings.feather * triangleCircumradius +
    extraMargin
  );
}

export function cascadeSize(
  size: RenderSize,
  probeDensity = PROBE_DENSITY,
): RenderSize {
  return {
    width: Math.max(1, Math.round(size.width * probeDensity)),
    height: Math.max(1, Math.round(size.height * probeDensity)),
  };
}

export function cascadeFitRect(
  size: RenderSize,
  probeDensity = PROBE_DENSITY,
): CascadeFitRect {
  const full = cascadeSize(size, probeDensity);
  const alignment = CASCADE0_DIMS << (MAX_CASCADE_COUNT - 1);
  const triangle = canonicalTriangleGeometry(size);
  // Fit the cascade to probes that can affect the current triangle emitter. This
  // intentionally uses the default PR #47 discard envelope so the default route
  // gets the intended FBO reduction. Very large debug GUI discard/padding values
  // may extend beyond this allocation until the next resize/density rebuild.
  const padding = PROBE_DISCARD_DEFAULTS.lightAabbPadding;
  const lightMinX = triangle.left.x - padding;
  const lightMinY = triangle.top.y - padding;
  const lightMaxX = triangle.right.x + padding;
  const lightMaxY = triangle.left.y + padding;
  const lightWidth = lightMaxX - lightMinX;
  const lightHeight = lightMaxY - lightMinY;
  const margin =
    PROBE_DISCARD_DEFAULTS.probeDiscardDistance *
    1.5 *
    Math.max(lightWidth, lightHeight);
  const scenePerCascadeX = size.width / full.width;
  const scenePerCascadeY = size.height / full.height;
  const minX = Math.max(
    0,
    alignDown(Math.floor((lightMinX - margin) / scenePerCascadeX), alignment),
  );
  const minY = Math.max(
    0,
    alignDown(Math.floor((lightMinY - margin) / scenePerCascadeY), alignment),
  );
  const maxX = Math.min(
    full.width,
    alignUp(Math.ceil((lightMaxX + margin) / scenePerCascadeX), alignment),
  );
  const maxY = Math.min(
    full.height,
    alignUp(Math.ceil((lightMaxY + margin) / scenePerCascadeY), alignment),
  );
  const width = Math.max(alignment, maxX - minX);
  const height = Math.max(alignment, maxY - minY);
  const originX = Math.min(minX, Math.max(0, full.width - width));
  const originY = Math.min(minY, Math.max(0, full.height - height));
  const clampedWidth = Math.min(width, full.width);
  const clampedHeight = Math.min(height, full.height);
  return {
    originX,
    originY,
    width: clampedWidth,
    height: clampedHeight,
    fullWidth: full.width,
    fullHeight: full.height,
    alignment,
    areaRatio:
      (clampedWidth * clampedHeight) / Math.max(1, full.width * full.height),
    originSceneX: (originX * size.width) / full.width,
    originSceneY: (originY * size.height) / full.height,
    widthScene: (clampedWidth * size.width) / full.width,
    heightScene: (clampedHeight * size.height) / full.height,
  };
}

function alignDown(value: number, alignment: number) {
  return Math.floor(value / alignment) * alignment;
}

function alignUp(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

export function probeDiscardOverlaySpacing(
  size: RenderSize,
  probeDensity = PROBE_DENSITY,
): number {
  // Debug overlay spacing is measured in scene/simulation pixels and remains a
  // readable sampling of the real probe lattice. Preserve the default PR #47
  // spacing at PROBE_DENSITY, then scale inversely for runtime density changes.
  return Math.max(
    1,
    Math.round(
      (canonicalTriangleGeometry(size).height * PROBE_DENSITY) /
        (TRIANGLE_AABB_PROBES_Y * probeDensity),
    ),
  );
}

export function cascadeCount(size: RenderSize) {
  const diagonal = Math.hypot(size.width, size.height);
  for (let level = 0; level < 16; level++) {
    const end =
      (CASCADE0_RANGE * (1 - CASCADE_FACTOR ** (level + 1))) /
      (1 - CASCADE_FACTOR);
    if (end > diagonal) return Math.min(level + 1, MAX_CASCADE_COUNT);
  }
  return MAX_CASCADE_COUNT;
}

export function canonicalTriangleGeometry(size: RenderSize): TriangleGeometry {
  // Canonical route geometry is based on CSS/simulation canvas height so aspect ratio does not change scale.
  // For an upright equilateral triangle: height = circumradius + inradius = 3 * inradius = 1.5 * circumradius.
  const height = size.height * TRIANGLE_HEIGHT_RATIO;
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

export function triangleLedRadius(size: RenderSize): number {
  return canonicalTriangleGeometry(size).height * LED_RADIUS_TO_TRIANGLE_HEIGHT;
}

export function triangleAnchorIndices(perEdge: number) {
  const total = perEdge * 3;
  const vertices = [
    (0 * perEdge - 0.5 + total) % total,
    (1 * perEdge - 0.5 + total) % total,
    (2 * perEdge - 0.5 + total) % total,
  ] as const;
  const midpoints = [
    0 * perEdge + (perEdge / 2 - 0.5),
    1 * perEdge + (perEdge / 2 - 0.5),
    2 * perEdge + (perEdge / 2 - 0.5),
  ] as const;
  return { vertices, midpoints };
}

export function triangleEdgeLedLayout(
  size: RenderSize,
  perEdge: number,
): TriangleLayout {
  const geometry = canonicalTriangleGeometry(size);
  const { top: v0, left: v1, right: v2, center } = geometry;
  const edges = [
    [v0, v1],
    [v1, v2],
    [v2, v0],
  ] as const;
  const positions: LedPosition[] = [];
  for (const [a, b] of edges) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    for (let i = 0; i < perEdge; i++) {
      const t = (i + 0.5) / perEdge;
      positions.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle,
      });
    }
  }
  return { center, positions, geometry, ledRadius: triangleLedRadius(size) };
}

export function triangleEdgeLedPositions(
  size: RenderSize,
  perEdge: number,
): LedPosition[] {
  return triangleEdgeLedLayout(size, perEdge).positions;
}

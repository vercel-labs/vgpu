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
 */
export const PROBE_DENSITY = 2;
export const MIN_PROBE_DENSITY = 0.5;
export const MAX_PROBE_DENSITY = 4;
export const CASCADE0_RANGE = 1;
export const CASCADE_FACTOR = 4;
export const MAX_CASCADE_COUNT = 5;
export const TRIANGLE_AABB_PROBES_Y = 8;
export const LAZY_RADIUS = 60;
export const LEDS_PER_EDGE = 24;
/**
 * On-screen triangle height as a fraction of the canvas height. Base `180 / 630` (≈28.57%,
 * matching the original fixed-sim + camera framing) scaled by 0.8 — the camera framing we
 * settled on (found via the `?heroCameraZoom` experiment) so the glow fits the 3:2 canvas
 * without top/bottom clipping. `?heroCameraZoom` multiplies this further at runtime (default
 * 1) via {@link setHeroSceneScale}.
 */
export const TRIANGLE_HEIGHT_RATIO = (180 / 630) * 0.8;
export const FIXED_TRIANGLE_CSS_HEIGHT = 180;
/**
 * Logical CSS HEIGHT the static fallback is baked for. The fallback image is displayed
 * filling the canvas HEIGHT (static-fallback.tsx), so it scales with the canvas just like
 * the live triangle and the reveal stays aligned at every size. This is the HEIGHT anchor
 * for the 3:2 bake (the width is {@link FALLBACK_CSS_WIDTH}).
 */
export const FALLBACK_CSS_SIZE = 1024;
/**
 * Logical CSS WIDTH the static fallback is baked for: 1.5 × the height ({@link
 * FALLBACK_CSS_SIZE}) so the baked image is 3:2, matching the live height-driven 3:2
 * canvas. Used by the bake script and the fallback display dims.
 */
export const FALLBACK_CSS_WIDTH = FALLBACK_CSS_SIZE * 1.5;
/** Desktop cap (CSS px) for the canvas HEIGHT; the width caps at 1.5× this (3:2). */
export const HERO_CANVAS_MAX_CSS = 720;
/**
 * Minimum simulation HEIGHT (CSS px) the live worker renders at. The simulation resolution
 * drives how much per-LED color detail the radiance / light-source field carries; on a short
 * canvas a CSS-height-matched sim is too coarse and adjacent-hue LEDs merge into a washed-out
 * (desaturated) glow. {@link simulationFloorFactor} floors the sim height to this so low
 * canvases keep enough color detail, at the (intended) cost of extra pixels there. Tall
 * canvases (height >= this) are unaffected. Tunable.
 */
export const MIN_SIM_HEIGHT = 360;
/**
 * Uniform scale-up factor (>= 1) from CSS px to simulation px, flooring the sim HEIGHT to
 * {@link MIN_SIM_HEIGHT}. Both sim dims scale by this SAME factor so the sim keeps the canvas
 * aspect (the fit transform stays uniform; see presentationSimulationTransform), and the
 * pointer maps to sim space by the same factor. Returns 1 (no-op) for tall canvases, so
 * desktop is byte-identical.
 */
export function simulationFloorFactor(cssHeight: number): number {
  return Math.max(1, MIN_SIM_HEIGHT / Math.max(1, cssHeight));
}
/**
 * Code-set, responsive render-rate cap (frames per second) for the live hero. The worker
 * gate ({@link shouldRenderFrame}) renders no faster than this, so mobile halves the rate
 * to cut WebGPU cost on phones while desktop stays at 60. Chosen at the hero-shader call
 * site via {@link isHeroMobileBreakpoint} and resolved once at init (a runtime breakpoint
 * cross does NOT re-cap the running worker).
 */
export const HERO_TARGET_FPS_DESKTOP = 60;
export const HERO_TARGET_FPS_MOBILE = 30;
/**
 * Responsive default scene zoom sent to the worker at init. Chosen so the
 * triangle fills the canvas comfortably at each breakpoint — desktop is
 * slightly wider relative to the 3:2 canvas, mobile needs a bit more zoom to
 * read well on narrow screens. Overridable at runtime via `?heroCameraZoom`.
 */
export const HERO_CAMERA_ZOOM_DESKTOP = 1.3;
export const HERO_CAMERA_ZOOM_MOBILE = 1.6;
export const LED_RADIUS_TO_TRIANGLE_HEIGHT = 0.0236;
export const LED_COLOR = { r: 16, g: 16, b: 16 } as const;
/**
 * Normal half-thickness keeps the pre-existing LED strip thickness
 * (`ledRadius * 2`).
 */
export const LED_NORMAL_HALF_THICKNESS_TO_RADIUS = 2;
/** Desired full pixel gap between neighboring LED rectangles along an edge. */
export const LED_TANGENT_GAP_PX = 1;
/** Small pixel margin added to the equilateral-corner tangent trim. */
export const LED_CORNER_TRIM_EPSILON_PX = 1;
/**
 * Inset (px, toward the centroid) of the LED mesh so it sits fully inside the floor's black
 * occluder triangle (drawn at the canonical edge) and doesn't peek past it on large/high-DPI
 * screens. The analytic raycast casts rays at this SAME inset triangle ({@link
 * ledMeshGeometry}) — not the canonical edge — so the ray hits land exactly on the lit edge and
 * the glow has no sawtooth; only the occluder uses the full canonical triangle, so it still
 * covers this inset mesh.
 */
export const LED_MESH_INSET_PX = 5;

export const HERO_STATE_MODES = {
  coding: 'coding',
  scan: 'scan',
  pulse: 'pulse',
  edge: 'edge',
  lines: 'lines',
  lines2: 'lines2',
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
  edgeIndex: number;
  edgeBaseBrightness: number;
  edgeHighlightBrightness: number;
}

export const HERO_STATE_DEFAULTS: HeroStateSettings = {
  mode: HERO_STATE_MODES.lines,
  transitionDuration: 0.25,
  scanSpeed: 0.08,
  scanHeadWidth: 7.5,
  scanRedShift: 0.3,
  scanBlueShift: 0.3,
  scanHueRotationSpeed: 0.03,
  pulseSpeed: 0.25,
  pulseWidth: 4,
  edgeIndex: 0,
  edgeBaseBrightness: 0.05,
  edgeHighlightBrightness: 0.4,
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
  edgeIndex: { min: 0, max: 2, step: 1 },
  edgeBaseBrightness: { min: 0, max: 1, step: 0.01 },
  edgeHighlightBrightness: { min: 0, max: 2, step: 0.01 },
} as const;

export function mergeHeroStateSettings(
  patch?: Partial<HeroStateSettings>,
): HeroStateSettings {
  return { ...HERO_STATE_DEFAULTS, ...patch };
}

/**
 * Square reference simulation size used ONLY by the non-live paths — the bench metadata
 * default and the size-derived cascade-count default. The LIVE worker sizes the
 * simulation from the measured canvas (sim == canvas), so this reference never drives an
 * on-screen render; it just yields a stable default.
 */
export function fixedSimulationSize(): RenderSize {
  return { width: FALLBACK_CSS_SIZE, height: FALLBACK_CSS_SIZE };
}

export function clampProbeDensity(
  value: number | undefined,
  fallback = PROBE_DENSITY,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(MAX_PROBE_DENSITY, Math.max(MIN_PROBE_DENSITY, value));
}

export function parseHeroProbeDensityParam(
  params: URLSearchParams,
  fallback = PROBE_DENSITY,
): number {
  const raw = params.get('heroProbeDensity');
  if (raw === null) return fallback;

  return clampProbeDensity(Number(raw), fallback);
}

export function clampHeroCascadeCount(
  value: number | undefined,
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.min(MAX_CASCADE_COUNT, Math.max(1, Math.floor(value)));
}

export function parseHeroCascadeCountParam(
  params: URLSearchParams,
): number | undefined {
  const raw = params.get('heroCascadeCount');
  if (raw === null) return undefined;

  return clampHeroCascadeCount(Number(raw));
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
  ledShape: TriangleLedShapeDimensions;
}
export interface TriangleLedShapeDimensions {
  /**
   * Half-size perpendicular to the triangle edge; intentionally matches the old
   * square impostor half-extent.
   */
  normalHalfThickness: number;
  /**
   * Half-size parallel to the triangle edge, shortened to leave straight-edge
   * and corner gaps.
   */
  tangentHalfLength: number;
  /**
   * Tangent trim applied at both vertices of each edge before slot centers are
   * distributed.
   */
  cornerTrim: number;
  /** Center-to-center spacing after trimming both vertices of each edge. */
  centerSpacing: number;
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
  /** Pointer-proximity LED glow: while the pointer is over the hero, LEDs within `glowRadius`
   *  (sim px) of it are mixed toward max brightness by up to `glowStrength` (smooth falloff).
   *  Optional: absent (e.g. offline bake/parity brushes) → no glow. DEFAULT_BRUSH provides them. */
  glowEnabled?: boolean;
  glowRadius?: number;
  glowStrength?: number;
  /** Exponential smoothing time constant (s) for the per-LED glow: the glow eases in/out and
   *  follows the pointer instead of snapping. 0 = instant. */
  glowSmoothing?: number;
  /** Weight the per-LED glow by how much the LED faces the pointer, so LEDs on the far side of the
   *  triangle (their outward edge normal pointing away from the pointer) don't light up. This is a
   *  back-face cull with a soft edge, NOT a linear cosine falloff: the weight is full for any LED
   *  whose normal-to-pointer angle is ≤ {@link glowFacingFullDeg}, then ramps to 0 by
   *  {@link glowFacingZeroDeg}. Absent → no facing weight (legacy position-only glow). */
  glowFacingEnabled?: boolean;
  /** Normal-to-pointer angle (deg) at/below which the facing weight is full (1). Default 90 — i.e.
   *  any LED whose normal has a non-negative component toward the pointer is fully lit. */
  glowFacingFullDeg?: number;
  /** Normal-to-pointer angle (deg) at/above which the facing weight is 0 (LED fully back-facing).
   *  Between this and {@link glowFacingFullDeg} the weight lerps 1→0. Default 100. */
  glowFacingZeroDeg?: number;
  /** Mouse-only: trigger distance (as a fraction of the triangle height) within which the 'lines'
   *  animation fades out as the pointer approaches the triangle — so only the pointer glow lights
   *  the LEDs in that band. Lines return when far or on/inside the triangle. 0 = disabled. */
  linesFadeDistance?: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 28,
  friction: 5,
  colour: { r: 1, g: 1, b: 1 },
  glowEnabled: true,
  glowRadius: 165,
  glowStrength: 1,
  glowSmoothing: 0.23,
  glowFacingEnabled: true,
  glowFacingFullDeg: 90,
  glowFacingZeroDeg: 100,
  linesFadeDistance: 0.6,
};

export const BRUSH_RANGES = {
  glowRadius: { min: 10, max: 400, step: 1 },
  glowStrength: { min: 0, max: 1, step: 0.01 },
  glowSmoothing: { min: 0, max: 0.5, step: 0.005 },
  glowFacingFullDeg: { min: 0, max: 180, step: 1 },
  glowFacingZeroDeg: { min: 0, max: 180, step: 1 },
  linesFadeDistance: { min: 0, max: 2, step: 0.05 },
} as const;

// Fixed CSS/simulation pixel expansion for the visible emitter crop.
export const LED_SDF_CROP_EXPANSION_PX = 2;
// Fixed mesh coverage so the shader crop has enough emitter pixels to clip.
// Small overlap: the emitter mesh only needs to cover the un-padded LED SDF
// boxes (the visible LED shape comes from the SDF prepass, not this padding).
export const LED_EMITTER_MESH_EXPANSION_PX = 1;
// Default triangle inset, in pixels, for the SDF written to the light/raycast prepass.
export const LED_RAYCAST_CLIP_INSET_PX = 2;

export const TUNABLE_DEFAULTS = {
  darkFloorAlbedo: 1,
  lightFloorAlbedo: 1,
  ledIntensity: 1,
  noiseScale: 0.01,
  rotationSpeed: -0.2,
  brightnessMin: 0.09,
  /** Dark-theme LED noise brightness floor; light uses `brightnessMin`. */
  brightnessMinDark: 0.05,
  // Dark-theme max LED intensity. Kept at 1 (not higher): above this, a bright COLORED band
  // at an edge midpoint over-saturates and burns to black pixels in dark mode. Light uses
  // brightnessMaxLight.
  brightnessMax: 1,
  /** Light-theme max LED intensity; dark uses `brightnessMax`. */
  brightnessMaxLight: 1.02,
  ledHitThreshold: 1.0,
  ledRaycastClipInsetPx: LED_RAYCAST_CLIP_INSET_PX,
} as const;

/**
 * Seconds the coding-noise rotation is advanced on the first frame, so the live
 * hero starts at this rotation phase instead of zero. The static fallback bake
 * renders this exact same phase, so the two match and the canvas reveals over the
 * static seamlessly. Single source of truth for both — change here to move both.
 */
export const NOISE_ROTATION_START_SECONDS = 10;

/**
 * On startup the coding-noise rotation does a fast burst that fades out to the
 * normal speed, so the quick motion masks the static→canvas reveal. The velocity
 * starts at `ROTATION_STARTUP_BOOST`× the default and decays exponentially (fastest
 * at the very first frame), reaching ≈1× by `ROTATION_STARTUP_DURATION_SECONDS`.
 * Bump the boost for a more obvious burst, the duration for a longer fade. Live
 * only — a single static-bake frame has no velocity, so this never touches the
 * fallback image (no re-bake needed when tuning these).
 */
export const ROTATION_STARTUP_BOOST = 6;
export const ROTATION_STARTUP_DURATION_SECONDS = 2;

export const TUNABLE_RANGES = {
  darkFloorAlbedo: { min: 0, max: 1, step: 0.01 },
  lightFloorAlbedo: { min: 0, max: 1, step: 0.01 },
  ledIntensity: { min: 1, max: 64, step: 0.5 },
  noiseScale: { min: 0.001, max: 0.1, step: 0.001 },
  rotationSpeed: { min: -3, max: 3, step: 0.05 },
  brightnessMin: { min: 0, max: 1, step: 0.01 },
  brightnessMinDark: { min: 0, max: 1, step: 0.01 },
  brightnessMax: { min: 0, max: 2, step: 0.01 },
  brightnessMaxLight: { min: 0, max: 2, step: 0.01 },
  ledHitThreshold: { min: 0, max: 2, step: 0.01 },
  ledRaycastClipInsetPx: { min: -4, max: 8, step: 0.25 },
} as const;

/**
 * Multiplier applied to the configured brightnessMin floor while the pointer hovers the triangle:
 * the floor eases toward (base × this) on hover, then settles back once the pointer leaves. Relative
 * (not an absolute target) so it keeps working when the base brightnessMin values are retuned.
 */
export const BRIGHTNESS_MIN_HOVER_MULTIPLIER = 4;
/** Exponential smoothing time constant (seconds) for the hover brightnessMin transition. */
export const BRIGHTNESS_MIN_HOVER_SMOOTHING = 0.2;

/** An RGB color in [0,1] per channel. Used for the per-edge brand colors. */
export interface EdgeColorRgb {
  r: number;
  g: number;
  b: number;
}

export interface HoverRgbTintSettings {
  enabled: boolean;
  amount: number;
  radius: number;
  power: number;
  /** Exponential smoothing time constant (s) for the color deploy factor — used for BOTH
   *  directions (grayscale→color and color→grayscale) so the two transitions take equal time. */
  responseSmoothing: number;
  deployDurationSeconds: number;
  noiseBrightnessMin: number;
  noiseBrightnessMax: number;
  noiseBrightnessPower: number;
  /** Dark-mode per-edge LED colors, in LINEAR RGB (these tint the LED pixels on deploy). The GUI
   *  pickers are sRGB and convert to/from linear. Edge→color: top-left=red, bottom=green,
   *  right-top=blue. */
  edgeRedLinear: EdgeColorRgb;
  edgeGreenLinear: EdgeColorRgb;
  edgeBlueLinear: EdgeColorRgb;
  /** How much the three dark edge colors blend into each other. 1 = current; lower = sharper
   *  (more distinct per edge), higher = more overlap. Applied as a 1/overlap exponent on the
   *  per-edge blend weights. */
  edgeOverlap: number;
}

export const HOVER_RGB_TINT_DEFAULTS: HoverRgbTintSettings = {
  enabled: true,
  amount: 1,
  radius: 173,
  power: 3,
  responseSmoothing: 0.2,
  deployDurationSeconds: 0.5,
  noiseBrightnessMin: 0.3,
  noiseBrightnessMax: 10,
  noiseBrightnessPower: 2,
  // Linear RGB — equal to the EDGE_*_LINEAR constants in led-buffer.ts (no visual change).
  edgeRedLinear: { r: 0.896269, g: 0.027321, b: 0.051269 },
  edgeGreenLinear: { r: 0, g: 0.40724, b: 0.048172 },
  edgeBlueLinear: { r: 0, g: 0.278894, b: 1 },
  edgeOverlap: 1,
};

export const HOVER_RGB_TINT_RANGES = {
  amount: { min: 0, max: 1, step: 0.01 },
  radius: { min: 40, max: 600, step: 1 },
  power: { min: 0.25, max: 4, step: 0.05 },
  deployDurationSeconds: { min: 0.5, max: 8, step: 0.05 },
  responseSmoothing: { min: 0, max: 0.5, step: 0.005 },
  edgeOverlap: { min: 0.1, max: 4, step: 0.05 },
  noiseBrightnessMin: { min: 0, max: 1, step: 0.01 },
  noiseBrightnessMax: { min: 1, max: 10, step: 0.01 },
  noiseBrightnessPower: { min: 0.25, max: 4, step: 0.05 },
} as const;

export function mergeHoverRgbTintSettings(
  patch?: Partial<HoverRgbTintSettings>,
): HoverRgbTintSettings {
  return { ...HOVER_RGB_TINT_DEFAULTS, ...patch };
}

export interface ProbeDiscardSettings {
  lightAabbPadding: number;
}

/**
 * Radiance reach as a multiple of the triangle circumradius — the single knob for
 * how far the dark-floor middle (SDF) glow extends around the triangle. It drives
 * the visible falloff ({@link DARK_FLOOR_DEFAULTS}.sdfFadeDistanceScale). The
 * on-screen cull (floor fade / bloom / composite) is no longer distance-based: it
 * tracks the radiance coverage box ({@link radianceScreenBounds}) directly.
 */
export const SDF_FADE_DISTANCE_SCALE = 0.75;

export const PROBE_DISCARD_DEFAULTS: ProbeDiscardSettings = {
  lightAabbPadding: 0,
};

export const PROBE_DISCARD_RANGES = {
  lightAabbPadding: { min: 0, max: 512, step: 1 },
} as const;

export function mergeProbeDiscardSettings(
  patch?: Partial<ProbeDiscardSettings>,
): ProbeDiscardSettings {
  return { ...PROBE_DISCARD_DEFAULTS, ...patch };
}

export interface LightAoSettings {
  radiance: number;
  contactOpacity: number;
  contactSize: number;
  contactFalloffPower: number;
  highlightPower: number;
  highlightStrength: number;
}

export const LIGHT_AO_DEFAULTS: LightAoSettings = {
  radiance: 0.07,
  contactOpacity: 0.1,
  contactSize: 3,
  contactFalloffPower: 1.6,
  highlightPower: 0.7,
  highlightStrength: 1.25,
};

export const LIGHT_AO_RANGES = {
  radiance: { min: 0, max: 2, step: 0.01 },
  contactOpacity: { min: 0, max: 0.2, step: 0.01 },
  contactSize: { min: 0.01, max: 10, step: 0.05 },
  contactFalloffPower: { min: 0.5, max: 8, step: 0.05 },
  highlightPower: { min: 0.25, max: 4, step: 0.05 },
  highlightStrength: { min: 0, max: 4, step: 0.05 },
} as const;

export function mergeLightAoSettings(
  patch?: Partial<LightAoSettings>,
): LightAoSettings {
  return { ...LIGHT_AO_DEFAULTS, ...patch };
}

export interface RadianceDebugSettings {
  enabled: boolean;
  redMultiplier: number;
  greenMultiplier: number;
  blueMultiplier: number;
}

export const RADIANCE_DEBUG_DEFAULTS: RadianceDebugSettings = {
  enabled: false,
  redMultiplier: 1,
  greenMultiplier: 1,
  blueMultiplier: 1,
};

export const RADIANCE_DEBUG_RANGES = {
  redMultiplier: { min: 0, max: 20, step: 0.05 },
  greenMultiplier: { min: 0, max: 20, step: 0.05 },
  blueMultiplier: { min: 0, max: 20, step: 0.05 },
} as const;

export function mergeRadianceDebugSettings(
  patch?: Partial<RadianceDebugSettings>,
): RadianceDebugSettings {
  return { ...RADIANCE_DEBUG_DEFAULTS, ...patch };
}

export interface DarkFloorSettings {
  sdfFadeDistanceScale: number;
  sdfFadeEdgePx: number;
  nearFalloffPower: number;
  /**
   * Width of the near falloff's thin line as a multiple of the triangle
   * circumradius. The near falloff is its own SDF band hugging the triangle
   * (separate from the broad tail glow), remapped 0→1 across this distance.
   */
  nearFalloffDistanceScale: number;
  /** Brightness multiplier for the near line (may exceed 1 for HDR). */
  nearFalloffIntensity: number;
  /**
   * Value map applied to the radiance (light) before the SDF thin-line mask:
   * light luminance at/below mapMin reads 0 (off, so faint parts switch off),
   * at/above mapMax reads 1. Luminance is linear HDR. mapMin > mapMax inverts.
   */
  nearFalloffMapMin: number;
  nearFalloffMapMax: number;
  /**
   * Middle falloff: the original geometric SDF distance glow. Uses
   * sdfFadeDistanceScale (× circumradius) for distance and sdfFadeEdgePx for its
   * inner edge; shaped by middleFalloffPower and scaled by middleFalloffIntensity.
   */
  middleFalloffPower: number;
  middleFalloffIntensity: number;
  /** Brightness multiplier for the tail (natural light fade). */
  tailIntensity: number;
  /**
   * Value map for the tail. A pure light fade (no SDF): radiance luminance
   * at/below tailMapMin reads 0, at/above tailMapMax reads 1. Linear HDR;
   * tailMapMin > tailMapMax inverts.
   */
  tailMapMin: number;
  tailMapMax: number;
  /** Curve applied to the tail after the value map, before tail intensity. */
  tailPower: number;
  /** Debug toggles to enable/disable each falloff layer independently. */
  nearFalloffEnabled: boolean;
  middleFalloffEnabled: boolean;
  farFalloffEnabled: boolean;
  /**
   * Master toggle for the floor noise. On (default, realtime/WebGPU) it modulates
   * the floor lightness and drives the jittered second radiance sample that hides
   * low-res cascade artifacts. Off (static bake) → flat floor + a single radiance
   * sample, so the baked glow is smooth and the grain is reintroduced as a separate
   * CSS noise overlay. Lets the static fallback reuse the exact same shader.
   */
  noiseEnabled: boolean;
  /**
   * Max screen-pixel distance for the noise-driven jittered radiance multisample
   * that dithers away the low-quality radiance-cascade artifacts. The floor noise
   * scales the jitter by (1 - noise) and blends the offset sample by the noise
   * amount; 0 disables the second sample.
   */
  radianceJitterPx: number;
  vibrancy: number;
  /** Backward-compatible alias for older persisted/GUI patches. */
  sdfFalloffPower?: number;
}

export const DARK_FLOOR_DEFAULTS: DarkFloorSettings = {
  sdfFadeDistanceScale: SDF_FADE_DISTANCE_SCALE,
  sdfFadeEdgePx: 0,
  nearFalloffPower: 4.0,
  nearFalloffDistanceScale: 0.046,
  nearFalloffIntensity: 1.2,
  nearFalloffMapMin: 2.74,
  nearFalloffMapMax: 5.0,
  middleFalloffPower: 1.0,
  middleFalloffIntensity: 0.16,
  tailIntensity: 0.65,
  tailMapMin: 0.0,
  tailMapMax: 8.85,
  tailPower: 0.05,
  nearFalloffEnabled: true,
  middleFalloffEnabled: false,
  farFalloffEnabled: true,
  noiseEnabled: true,
  radianceJitterPx: 16,
  vibrancy: 2,
};

// Slider ranges are tuned so each default sits in a controllable mid-range spot
// (not pinned to an edge) with a fine step. Edit defaults in DARK_FLOOR_DEFAULTS.
export const DARK_FLOOR_RANGES = {
  sdfFadeDistanceScale: { min: 0.1, max: 4, step: 0.05 },
  sdfFadeEdgePx: { min: -256, max: 256, step: 1 },
  nearFalloffPower: { min: 1, max: 16, step: 0.1 },
  nearFalloffDistanceScale: { min: 0, max: 0.12, step: 0.002 },
  nearFalloffIntensity: { min: 0, max: 32, step: 0.1 },
  nearFalloffMapMin: { min: 0, max: 3, step: 0.005 },
  nearFalloffMapMax: { min: 0, max: 5, step: 0.01 },
  middleFalloffPower: { min: 0, max: 1, step: 0.01 },
  middleFalloffIntensity: { min: 0, max: 2, step: 0.02 },
  tailIntensity: { min: 0, max: 3, step: 0.05 },
  tailMapMin: { min: 0, max: 1, step: 0.01 },
  tailMapMax: { min: 0, max: 10, step: 0.01 },
  tailPower: { min: 0, max: 1.5, step: 0.01 },
  radianceJitterPx: { min: 0, max: 32, step: 0.25 },
  vibrancy: { min: 0, max: 2, step: 0.01 },
} as const;

export function assignDarkFloorSettings(
  target: DarkFloorSettings,
  patch?: Partial<DarkFloorSettings>,
): DarkFloorSettings {
  target.sdfFadeDistanceScale = DARK_FLOOR_DEFAULTS.sdfFadeDistanceScale;
  target.sdfFadeEdgePx = DARK_FLOOR_DEFAULTS.sdfFadeEdgePx;
  target.nearFalloffPower = DARK_FLOOR_DEFAULTS.nearFalloffPower;
  target.nearFalloffDistanceScale =
    DARK_FLOOR_DEFAULTS.nearFalloffDistanceScale;
  target.nearFalloffIntensity = DARK_FLOOR_DEFAULTS.nearFalloffIntensity;
  target.nearFalloffMapMin = DARK_FLOOR_DEFAULTS.nearFalloffMapMin;
  target.nearFalloffMapMax = DARK_FLOOR_DEFAULTS.nearFalloffMapMax;
  target.middleFalloffPower = DARK_FLOOR_DEFAULTS.middleFalloffPower;
  target.middleFalloffIntensity = DARK_FLOOR_DEFAULTS.middleFalloffIntensity;
  target.tailIntensity = DARK_FLOOR_DEFAULTS.tailIntensity;
  target.tailMapMin = DARK_FLOOR_DEFAULTS.tailMapMin;
  target.tailMapMax = DARK_FLOOR_DEFAULTS.tailMapMax;
  target.tailPower = DARK_FLOOR_DEFAULTS.tailPower;
  target.nearFalloffEnabled = DARK_FLOOR_DEFAULTS.nearFalloffEnabled;
  target.middleFalloffEnabled = DARK_FLOOR_DEFAULTS.middleFalloffEnabled;
  target.farFalloffEnabled = DARK_FLOOR_DEFAULTS.farFalloffEnabled;
  target.noiseEnabled = DARK_FLOOR_DEFAULTS.noiseEnabled;
  target.radianceJitterPx = DARK_FLOOR_DEFAULTS.radianceJitterPx;
  target.vibrancy = DARK_FLOOR_DEFAULTS.vibrancy;

  if (!patch) return target;

  target.sdfFadeDistanceScale =
    patch.sdfFadeDistanceScale ?? target.sdfFadeDistanceScale;
  target.sdfFadeEdgePx = patch.sdfFadeEdgePx ?? target.sdfFadeEdgePx;
  target.nearFalloffPower =
    patch.nearFalloffPower ?? patch.sdfFalloffPower ?? target.nearFalloffPower;
  target.nearFalloffDistanceScale =
    patch.nearFalloffDistanceScale ?? target.nearFalloffDistanceScale;
  target.nearFalloffIntensity =
    patch.nearFalloffIntensity ?? target.nearFalloffIntensity;
  target.nearFalloffMapMin =
    patch.nearFalloffMapMin ?? target.nearFalloffMapMin;
  target.nearFalloffMapMax =
    patch.nearFalloffMapMax ?? target.nearFalloffMapMax;
  target.middleFalloffPower =
    patch.middleFalloffPower ?? target.middleFalloffPower;
  target.middleFalloffIntensity =
    patch.middleFalloffIntensity ?? target.middleFalloffIntensity;
  target.tailIntensity = patch.tailIntensity ?? target.tailIntensity;
  target.tailMapMin = patch.tailMapMin ?? target.tailMapMin;
  target.tailMapMax = patch.tailMapMax ?? target.tailMapMax;
  target.tailPower = patch.tailPower ?? target.tailPower;
  target.nearFalloffEnabled =
    patch.nearFalloffEnabled ?? target.nearFalloffEnabled;
  target.middleFalloffEnabled =
    patch.middleFalloffEnabled ?? target.middleFalloffEnabled;
  target.farFalloffEnabled =
    patch.farFalloffEnabled ?? target.farFalloffEnabled;
  target.noiseEnabled = patch.noiseEnabled ?? target.noiseEnabled;
  target.radianceJitterPx = patch.radianceJitterPx ?? target.radianceJitterPx;
  target.vibrancy = patch.vibrancy ?? target.vibrancy;

  return target;
}

export function mergeDarkFloorSettings(
  patch?: Partial<DarkFloorSettings>,
): DarkFloorSettings {
  return assignDarkFloorSettings(
    {
      sdfFadeDistanceScale: DARK_FLOOR_DEFAULTS.sdfFadeDistanceScale,
      sdfFadeEdgePx: DARK_FLOOR_DEFAULTS.sdfFadeEdgePx,
      nearFalloffPower: DARK_FLOOR_DEFAULTS.nearFalloffPower,
      nearFalloffDistanceScale: DARK_FLOOR_DEFAULTS.nearFalloffDistanceScale,
      nearFalloffIntensity: DARK_FLOOR_DEFAULTS.nearFalloffIntensity,
      nearFalloffMapMin: DARK_FLOOR_DEFAULTS.nearFalloffMapMin,
      nearFalloffMapMax: DARK_FLOOR_DEFAULTS.nearFalloffMapMax,
      middleFalloffPower: DARK_FLOOR_DEFAULTS.middleFalloffPower,
      middleFalloffIntensity: DARK_FLOOR_DEFAULTS.middleFalloffIntensity,
      tailIntensity: DARK_FLOOR_DEFAULTS.tailIntensity,
      tailMapMin: DARK_FLOOR_DEFAULTS.tailMapMin,
      tailMapMax: DARK_FLOOR_DEFAULTS.tailMapMax,
      tailPower: DARK_FLOOR_DEFAULTS.tailPower,
      nearFalloffEnabled: DARK_FLOOR_DEFAULTS.nearFalloffEnabled,
      middleFalloffEnabled: DARK_FLOOR_DEFAULTS.middleFalloffEnabled,
      farFalloffEnabled: DARK_FLOOR_DEFAULTS.farFalloffEnabled,
      noiseEnabled: DARK_FLOOR_DEFAULTS.noiseEnabled,
      radianceJitterPx: DARK_FLOOR_DEFAULTS.radianceJitterPx,
      vibrancy: DARK_FLOOR_DEFAULTS.vibrancy,
    },
    patch,
  );
}

export interface DarkPostprocessSettings {
  contrast: number;
  exposure: number;
}

export const DARK_POSTPROCESS_DEFAULTS: DarkPostprocessSettings = {
  contrast: 1.05,
  exposure: 0.25,
};

export const DARK_POSTPROCESS_RANGES = {
  contrast: { min: 0.5, max: 2.5, step: 0.01 },
  exposure: { min: 0, max: 4, step: 0.01 },
} as const;

export function mergeDarkPostprocessSettings(
  patch?: Partial<DarkPostprocessSettings>,
): DarkPostprocessSettings {
  return { ...DARK_POSTPROCESS_DEFAULTS, ...patch };
}

// Light-mode glow: a curated copy of the dark falloff params (near/middle/far) plus
// contrast, so light mode can build the same SDF/light glow and tune it
// independently of dark. Defaults mirror DARK_FLOOR_DEFAULTS / DARK_POSTPROCESS.
export interface LightGlowSettings {
  // Close (near) line hugging the triangle.
  nearDistanceScale: number;
  nearIntensity: number;
  nearMapMin: number;
  nearMapMax: number;
  nearPower: number;
  nearEnabled: boolean;
  // Middle geometric SDF distance glow.
  middleOuterScale: number;
  middlePower: number;
  middleIntensity: number;
  /** Highlight-mask noise: per-pixel hash grain that exaggerates the light highlight (the white
   *  push added to the base color). 0 = smooth. Carried in the MONO middle vec4 .z slot (single
   *  param — read from the mono set, not blended by colorMix). */
  highlightNoise: number;
  /** Debug toggle: when true, the light floor renders the raw `highlight` variable as opaque
   *  grayscale (carried in glowColor.y) — for inspecting the highlight mask. */
  highlightDebug: boolean;
  middleEnabled: boolean;
  // Far pure-light tail.
  farIntensity: number;
  farMapMin: number;
  farMapMax: number;
  farPower: number;
  farEnabled: boolean;
  // Shared.
  fadeInner: number;
  contrast: number;
  // COLOR set: a second, fully-independent copy of the per-layer glow SHAPE params used for the
  // colored/deploy floor. The light shader blends mono→color per layer by colorMix (0 = grayscale
  // mono floor, 1 = colored floor). highlightNoise is NOT duplicated — it is read from the mono set.
  // Close (near) line — color set.
  nearDistanceScaleColor: number;
  nearIntensityColor: number;
  nearMapMinColor: number;
  nearMapMaxColor: number;
  nearPowerColor: number;
  nearEnabledColor: boolean;
  // Middle geometric SDF distance glow — color set.
  middleOuterScaleColor: number;
  middlePowerColor: number;
  middleIntensityColor: number;
  middleEnabledColor: boolean;
  // Far pure-light tail — color set.
  farIntensityColor: number;
  farMapMinColor: number;
  farMapMaxColor: number;
  farPowerColor: number;
  farEnabledColor: boolean;
  // Shared — color set.
  fadeInnerColor: number;
  contrastColor: number;
  // Ground ambient-occlusion shadow (light mode, colors-off).
  aoStrength: number;
  aoRadiusScale: number;
  aoPower: number;
  aoEnabled: boolean;
  // Second (smaller/contact) AO layer.
  ao2Strength: number;
  ao2RadiusScale: number;
  ao2Power: number;
  ao2Enabled: boolean;
  // Third (tightest contact) AO layer.
  ao3Strength: number;
  ao3RadiusScale: number;
  ao3Power: number;
  ao3Enabled: boolean;
  /** Light-mode per-edge floor colors, in sRGB [0,1] (the floor shader tints the white light by
   *  edge; rgb_to_oklab expects sRGB). Edge→color: top-left=red, bottom=green, right-top=blue. */
  edgeRedRgb: EdgeColorRgb;
  edgeGreenRgb: EdgeColorRgb;
  edgeBlueRgb: EdgeColorRgb;
  /** How much the three light edge colors blend into each other. 1 = current; lower = sharper,
   *  higher = more overlap. Applied as a 1/overlap exponent on the per-edge angular weights. */
  edgeOverlap: number;
}

export const LIGHT_GLOW_DEFAULTS: LightGlowSettings = {
  // MONO set = image #24 (grayscale/idle floor).
  nearDistanceScale: 0.268,
  nearIntensity: 4,
  nearMapMin: 0,
  nearMapMax: 20,
  nearPower: 8,
  nearEnabled: true,
  middleOuterScale: 3.95,
  middlePower: 3.3,
  middleIntensity: 1.6,
  highlightNoise: 0.5,
  highlightDebug: false,
  middleEnabled: true,
  farIntensity: 1.2,
  farMapMin: 0.0,
  farMapMax: 3,
  farPower: 0.71,
  farEnabled: true,
  fadeInner: 41,
  contrast: 1.06,
  // COLOR set = image #23 (colored/deploy floor).
  nearDistanceScaleColor: 0.116,
  nearIntensityColor: 0.2,
  nearMapMinColor: 0.36,
  nearMapMaxColor: 4,
  nearPowerColor: 1.95,
  nearEnabledColor: true,
  middleOuterScaleColor: 3.95,
  middlePowerColor: 5.3,
  middleIntensityColor: 0.34,
  middleEnabledColor: true,
  farIntensityColor: 0.45,
  farMapMinColor: 0,
  farMapMaxColor: 1.25,
  farPowerColor: 0.22,
  farEnabledColor: true,
  fadeInnerColor: 0,
  contrastColor: 1.58,
  aoStrength: 0.18,
  aoRadiusScale: 0.8,
  aoPower: 4,
  aoEnabled: true,
  ao2Strength: 0.15,
  ao2RadiusScale: 0.14,
  ao2Power: 1.6,
  ao2Enabled: true,
  ao3Strength: 0.21,
  ao3RadiusScale: 0.18,
  ao3Power: 3.8,
  ao3Enabled: true,
  // sRGB [0,1] — image #22 edge colors (only the colored floor shows them).
  edgeRedRgb: { r: 0.8667, g: 0.2745, b: 0.302 }, // #dd464d
  edgeGreenRgb: { r: 0.3294, g: 0.698, b: 0.3255 }, // #54b253
  edgeBlueRgb: { r: 0.1804, g: 0.3451, b: 1.0 }, // #2e58ff
  edgeOverlap: 0.4,
};

export const LIGHT_GLOW_RANGES = {
  // "Close" ranges widened so higher values are allowed (shared by mono + color sets below).
  nearDistanceScale: { min: 0, max: 0.3, step: 0.002 },
  nearIntensity: { min: 0, max: 4, step: 0.1 },
  nearMapMin: { min: 0, max: 0.3, step: 0.005 },
  nearMapMax: { min: 0, max: 20, step: 0.01 },
  nearPower: { min: 1, max: 32, step: 0.1 },
  middleOuterScale: { min: 0.1, max: 4, step: 0.05 },
  middlePower: { min: 0, max: 8, step: 0.05 },
  middleIntensity: { min: 0, max: 2, step: 0.02 },
  highlightNoise: { min: 0, max: 2, step: 0.05 },
  farIntensity: { min: 0, max: 3, step: 0.05 },
  farMapMin: { min: 0, max: 1, step: 0.01 },
  farMapMax: { min: 0, max: 3, step: 0.01 },
  farPower: { min: 0, max: 1.5, step: 0.01 },
  fadeInner: { min: -256, max: 256, step: 1 },
  contrast: { min: 0.5, max: 2.5, step: 0.01 },
  // COLOR set ranges — same {min,max,step} as the mono counterparts above.
  nearDistanceScaleColor: { min: 0, max: 10, step: 0.002 },
  nearIntensityColor: { min: 0, max: 4, step: 0.1 },
  nearMapMinColor: { min: 0, max: 1, step: 0.005 },
  nearMapMaxColor: { min: 0, max: 4, step: 0.01 },
  nearPowerColor: { min: 0, max: 5, step: 0.01 },
  middleOuterScaleColor: { min: 0.1, max: 4, step: 0.05 },
  middlePowerColor: { min: 0, max: 8, step: 0.05 },
  middleIntensityColor: { min: 0, max: 2, step: 0.02 },
  farIntensityColor: { min: 0, max: 3, step: 0.05 },
  farMapMinColor: { min: 0, max: 1, step: 0.01 },
  farMapMaxColor: { min: 0, max: 3, step: 0.01 },
  farPowerColor: { min: 0, max: 1.5, step: 0.01 },
  fadeInnerColor: { min: -256, max: 256, step: 1 },
  contrastColor: { min: 0.5, max: 2.5, step: 0.01 },
  aoStrength: { min: 0, max: 2, step: 0.01 },
  aoRadiusScale: { min: 0, max: 3, step: 0.02 },
  aoPower: { min: 0.25, max: 8, step: 0.05 },
  ao2Strength: { min: 0, max: 2, step: 0.01 },
  ao2RadiusScale: { min: 0, max: 3, step: 0.02 },
  ao2Power: { min: 0.25, max: 8, step: 0.05 },
  ao3Strength: { min: 0, max: 2, step: 0.01 },
  ao3RadiusScale: { min: 0, max: 3, step: 0.02 },
  ao3Power: { min: 0.25, max: 8, step: 0.05 },
  edgeOverlap: { min: 0.1, max: 4, step: 0.05 },
} as const;

export function mergeLightGlowSettings(
  patch?: Partial<LightGlowSettings>,
): LightGlowSettings {
  return { ...LIGHT_GLOW_DEFAULTS, ...patch };
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
  // The cascade render targets are full-size: every probe across the whole
  // simulation is rendered (no margin crop). Far-probe culling is handled
  // per-ray inside the cascade shaders, and the visible glow is bounded by the
  // display-side culls, which track this coverage box ({@link
  // radianceScreenBounds}) — not by cropping radiance here.
  const full = cascadeSize(size, probeDensity);
  const alignment = CASCADE0_DIMS << (MAX_CASCADE_COUNT - 1);
  return {
    originX: 0,
    originY: 0,
    width: full.width,
    height: full.height,
    fullWidth: full.width,
    fullHeight: full.height,
    alignment,
    areaRatio: 1,
    originSceneX: 0,
    originSceneY: 0,
    widthScene: size.width,
    heightScene: size.height,
  };
}

/**
 * Presentation-space rect that the radiance covers on screen — the single source
 * of truth for the floor fade, dark composite, and bloom culls. The radiance
 * fully fills the fixed-size cascade ({@link cascadeFitRect} returns the whole
 * grid), so this equals that coverage centered in the presentation, and it
 * scales with the simulation size (TRIANGLE_HEIGHT_RATIO) automatically — no
 * probe-discard distance needed.
 */
export function radianceScreenBounds(
  simSize: RenderSize,
  presentationSize: RenderSize,
  pixelRatio: number,
  probeDensity = PROBE_DENSITY,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const fit = cascadeFitRect(simSize, probeDensity);
  const scale = Math.max(0.001, pixelRatio);
  const originX = (presentationSize.width - simSize.width * scale) * 0.5;
  const originY = (presentationSize.height - simSize.height * scale) * 0.5;
  const minX = originX + fit.originSceneX * scale;
  const minY = originY + fit.originSceneY * scale;
  return {
    minX,
    minY,
    maxX: minX + fit.widthScene * scale,
    maxY: minY + fit.heightScene * scale,
  };
}

export function probeDiscardOverlaySpacing(size: RenderSize): number {
  // Debug overlay spacing is measured in simulation pixels. The canonical LED
  // triangle scales from simulation height, so the overlay keeps its AABB
  // spanning about 8 visible probe markers on Y across viewport resizes without
  // reducing the actual radiance field resolution. Rendering quality remains
  // controlled by CASCADE0_DIMS.
  return Math.max(
    1,
    Math.round(canonicalTriangleGeometry(size).height / TRIANGLE_AABB_PROBES_Y),
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

/**
 * Session "camera zoom": a scene scale set once at init from the `?heroCameraZoom` query
 * param (default 1). It multiplies the on-screen triangle size in {@link
 * canonicalTriangleGeometry}, so the WHOLE scene — LED mesh, analytic ray-tracing, and the
 * floor glow — scales together about the canvas center while every pass keeps computing over
 * the full canvas (no coordinate rescale, no out-of-bounds sampling). `< 1` makes everything
 * smaller (more floor/glow fits, no top/bottom clipping); `> 1` bigger. A module-level value
 * (not threaded) because it is a constant per session, set independently on the worker and
 * the main thread from the same query param.
 */
let heroSceneScale = 1;
export function setHeroSceneScale(scale: number): void {
  heroSceneScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}
export function getHeroSceneScale(): number {
  return heroSceneScale;
}

/**
 * Canvas HEIGHT (CSS px) past which the scene zoom is frozen. The on-screen triangle is
 * `cssHeight × TRIANGLE_HEIGHT_RATIO × zoom`, so to keep a CONSTANT visual size on tall
 * canvases we scale the zoom down once the canvas exceeds this height.
 */
export const HERO_ZOOM_FREEZE_HEIGHT_CSS = 560;

/**
 * The scene scale to apply for a given base zoom and canvas height.
 *
 * - **Desktop** (default): the base zoom up to {@link HERO_ZOOM_FREEZE_HEIGHT_CSS}, then scaled
 *   down inversely with height so the on-screen triangle stays the size it had at the freeze
 *   height (the live shader just reveals more floor/glow above/below on taller canvases).
 * - **Mobile** (`mobile = true`): the base zoom verbatim, NO height freeze. On mobile the canvas
 *   is sized in CSS as a fraction of the available-space row (see hero-layout-client), so the
 *   canvas itself already scales the triangle with the available height; freezing by canvas
 *   height on top of that would cap/double-scale it at larger (tablet) breakpoints.
 *
 * Used identically on the worker (render) and the main thread (hover hit-test) so they never diverge.
 */
export function resolveHeroSceneScale(
  baseZoom: number,
  cssHeight: number,
  mobile = false,
): number {
  if (mobile) return baseZoom;
  if (!Number.isFinite(cssHeight) || cssHeight <= 0) return baseZoom;
  return baseZoom * Math.min(1, HERO_ZOOM_FREEZE_HEIGHT_CSS / cssHeight);
}

/**
 * Vertical screen-edge fade width as a fraction of the canvas HEIGHT — 0.1 on mobile, 0.2 on
 * desktop. The dark floor fades to black only on the Y axis (top/bottom), never on X; this is
 * the band height. A module-level value set once at init by the worker (mobile/desktop resolved
 * from the same `isHeroMobileBreakpoint` breakpoint as the FPS cap), mirroring {@link
 * setHeroSceneScale}; the floor pass packs it into the uniform. Non-live paths (exports, golden)
 * use the desktop default.
 */
let heroEdgeFadeFrac = 0.2;
export function setHeroEdgeFadeFrac(frac: number): void {
  heroEdgeFadeFrac = Number.isFinite(frac) && frac >= 0 ? frac : 0.2;
}
export function getHeroEdgeFadeFrac(): number {
  return heroEdgeFadeFrac;
}

export function canonicalTriangleGeometry(size: RenderSize): TriangleGeometry {
  // Canonical route geometry is based on CSS/simulation canvas height so aspect ratio does not change scale.
  // For an upright equilateral triangle: height = circumradius + inradius = 3 * inradius = 1.5 * circumradius.
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

export function triangleLedRadius(size: RenderSize): number {
  return canonicalTriangleGeometry(size).height * LED_RADIUS_TO_TRIANGLE_HEIGHT;
}

export function triangleLedNormalHalfThickness(size: RenderSize): number {
  return triangleLedRadius(size) * LED_NORMAL_HALF_THICKNESS_TO_RADIUS;
}

export function triangleLedCornerTrim(size: RenderSize): number {
  // Equilateral interior angle is 60deg, so trim = halfThickness * cot(30deg).
  const rawTrim =
    triangleLedNormalHalfThickness(size) * Math.sqrt(3) +
    LED_CORNER_TRIM_EPSILON_PX;
  const sideLength = canonicalTriangleGeometry(size).sideLength;
  return Math.min(rawTrim, sideLength * 0.45);
}

export function triangleLedShapeDimensions(
  size: RenderSize,
  perEdge: number,
): TriangleLedShapeDimensions {
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

export function triangleAnchorIndices(perEdge: number) {
  const total = perEdge * 3;
  const vertices = [
    (total - 0.5) % total,
    (1 * perEdge - 0.5 + total) % total,
    (2 * perEdge - 0.5 + total) % total,
  ] as const;
  const midpoints = [
    perEdge / 2 - 0.5,
    1 * perEdge + (perEdge / 2 - 0.5),
    2 * perEdge + (perEdge / 2 - 0.5),
  ] as const;
  return { vertices, midpoints };
}

/** Uniformly scales a triangle toward its centroid by factor `s` (1 = unchanged). */
function scaleTriangleGeometry(
  geo: TriangleGeometry,
  s: number,
): TriangleGeometry {
  const c = geo.center;
  const toward = (p: { x: number; y: number }) => ({
    x: c.x + (p.x - c.x) * s,
    y: c.y + (p.y - c.y) * s,
  });
  return {
    center: c,
    top: toward(geo.top),
    left: toward(geo.left),
    right: toward(geo.right),
    height: geo.height * s,
    circumradius: geo.circumradius * s,
    inradius: geo.inradius * s,
    sideLength: geo.sideLength * s,
  };
}

/**
 * Perpendicular-inset scale (toward the centroid) shared by the LED mesh and its raycast.
 * {@link LED_MESH_INSET_PX} is an absolute px inset; on a short canvas that fixed px pulls the
 * lit edge proportionally FURTHER inward, shifting where the analytic rays land (which discrete,
 * differently-hued LED each near-edge ray samples) → resolution-dependent hue mixing /
 * desaturation. Scaling the inset by the triangle height as a fraction of the desktop-cap
 * reference makes it a CONSTANT fraction of the triangle at any size. At the reference height
 * the factor is 1 (desktop byte-identical); same reference as the coding-noise frequency
 * ({@link NOISE_REFERENCE_TRIANGLE_HEIGHT}).
 */
function ledMeshScale(base: TriangleGeometry): number {
  const refHeight = HERO_CANVAS_MAX_CSS * TRIANGLE_HEIGHT_RATIO;
  const inset =
    (LED_MESH_INSET_PX * Math.min(base.height, refHeight)) / refHeight;
  return base.inradius > inset ? (base.inradius - inset) / base.inradius : 1;
}

/**
 * Geometry of the LED *mesh* triangle: the canonical triangle shrunk toward its centroid by
 * {@link LED_MESH_INSET_PX}. Single source of truth shared by {@link triangleEdgeLedLayout}
 * (where the emitters are drawn) AND the analytic raycast (`direct-triangle-raycast-pass`,
 * which casts rays at these edges), so the rays land exactly on the lit edge — no sawtooth at
 * the occluder boundary. The floor's black occluder keeps using the FULL {@link
 * canonicalTriangleGeometry} so it still fully covers this inset mesh.
 */
export function ledMeshGeometry(size: RenderSize): TriangleGeometry {
  const base = canonicalTriangleGeometry(size);
  return scaleTriangleGeometry(base, ledMeshScale(base));
}

export function triangleEdgeLedLayout(
  size: RenderSize,
  perEdge: number,
): TriangleLayout {
  // Shrink the LED mesh PROPORTIONALLY so it sits inside the floor's black occluder triangle
  // (which stays full size — it derives straight from canonicalTriangleGeometry, not this
  // layout) and doesn't peek past it on large/high-DPI screens. LED_MESH_INSET_PX is the
  // perpendicular inset at the edge; the WHOLE mesh — triangle, LED radius, spacing, corner
  // trim — scales by the same factor, so corners/spacing stay consistent (no overlaps). The
  // analytic raycast casts at this SAME inset triangle ({@link ledMeshGeometry}), so its rays
  // land on the lit edge (no sawtooth at the occluder boundary).
  const base = canonicalTriangleGeometry(size);
  const meshScale = ledMeshScale(base);
  const geometry = scaleTriangleGeometry(base, meshScale);
  const { top: v0, left: v1, right: v2, center } = geometry;
  const edges = [
    [v0, v1],
    [v1, v2],
    [v2, v0],
  ] as const;
  // Derive LED dimensions (spacing, corner trim, radius, thickness) from the same scaled
  // height so they shrink with the mesh and the corner caps don't overlap.
  const ledSizeForDims = { width: size.width, height: size.height * meshScale };
  const ledShape = triangleLedShapeDimensions(ledSizeForDims, perEdge);
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
      positions.push({
        x: a.x + dx * t,
        y: a.y + dy * t,
        angle,
      });
    }
  }
  return {
    center,
    positions,
    geometry,
    ledRadius: triangleLedRadius(ledSizeForDims),
    ledShape,
  };
}

export function triangleEdgeLedPositions(
  size: RenderSize,
  perEdge: number,
): LedPosition[] {
  return triangleEdgeLedLayout(size, perEdge).positions;
}

import { type Buffer, type Device } from '@vgpu/core';
import {
  HERO_CANVAS_MAX_CSS,
  HERO_STATE_MODES,
  LEDS_PER_EDGE,
  NOISE_ROTATION_START_SECONDS,
  // ROTATION_STARTUP_BOOST,           // re-enable with the startup boost (below)
  // ROTATION_STARTUP_DURATION_SECONDS,
  TRIANGLE_HEIGHT_RATIO,
  triangleAnchorIndices,
  triangleEdgeLedLayout,
  type HeroStateMode,
  type HeroStateSettings,
  type HoverRgbTintSettings,
  type RenderSize,
} from './settings';
import {
  type BrushState,
  type SceneTunables,
} from './light-sources-pass';
import { valueNoise2D } from './value-noise';

const LED_FLOATS = 8;
const POS_BRIGHTNESS_OFFSET = 0;
const COLOR_OFFSET = 4;
const LED_COUNT = LEDS_PER_EDGE * 3;
const PULSE_FLOOR = 0.08;
const PULSE_HALF_EDGE = LEDS_PER_EDGE / 2;
const PULSE_ANCHORS = triangleAnchorIndices(LEDS_PER_EDGE);
const PULSE_VERTICES = PULSE_ANCHORS.vertices;
const PULSE_MIDPOINTS = PULSE_ANCHORS.midpoints;
const PULSE_VERTEX_HOLD_END = 1 / 44;
const PULSE_SPLIT_END = 21 / 44;
const PULSE_MIDPOINT_HOLD_END = 23 / 44;
const PULSE_ROTATE_END = 43 / 44;
const PULSE_ROTATE_DIRECTION = 1;
const PULSE_CENTERS_SCRATCH = new Float32Array(6);
const SCAN_RED_ENDPOINT = new Float32Array(3);
const SCAN_BLUE_ENDPOINT = new Float32Array(3);
const EDGE_RED_LINEAR = { r: 0.896269, g: 0.027321, b: 0.051269 };
const EDGE_GREEN_LINEAR = { r: 0, g: 0.40724, b: 0.048172 };
const EDGE_BLUE_LINEAR = { r: 0, g: 0.278894, b: 1 };
// Rec. 709 luminance weights — must match the floor shader's LUMA so white and
// colored edges resolve to the same luminance, and therefore the same glow reach
// (the dark floor falloffs key off radiance luminance).
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

const TWO_PI = Math.PI * 2;
// Cap the per-frame rotation delta so a long pause (backgrounded tab) doesn't
// snap the noise rotation forward when the animation resumes.
const MAX_NOISE_FRAME_DELTA = 0.1;
/**
 * In active-edge mode (carousel hover) the two non-highlighted edges sit at this fraction of
 * the (theme-aware) LED brightness floor, so they read much darker than the fully-lit edge —
 * exaggerating the contrast. Exported so the tests track the value without a magic number.
 */
export const INACTIVE_EDGE_BRIGHTNESS_FACTOR = 0.125;
// Light + colored exception for active-edge mode (carousel hover): once the colored floor is fully
// revealed, on the LIGHT theme only, the highlighted edge is brightened to this multiple and the
// non-highlighted edges are dimmed to this fraction. Both ramp with the color-mix factor, so they
// track the reveal (no change in grayscale or on the dark theme).
const EDGE_HIGHLIGHT_LIGHT_COLOR_BOOST = 3;
const EDGE_INACTIVE_LIGHT_COLOR_SCALE = 0.2;
// Peak animation speed-up multiplier at the midpoint of a click transition. Applied to the
// shared animation clock, so EVERY mode (coding rotation, the moving lines, scan/pulse phase)
// accelerates together during a click — not just the coding rotation.
const CLICK_SPEED_BOOST_PEAK = 10;

// 'lines' mode (the default idle animation): three bright bands on the 72-LED perimeter ring.
// They START STACKED at one spot on the top-left edge — so the first frame reads as a single
// band covering most of the top-left edge and a little of the top-right near the apex, NOT a
// line on each corner — then separate as each moves at its own speed/direction. Each band also
// fades its whole intensity in and out slowly, at its own rate and phase, so they pulse
// independently. Per-LED COVERAGE in [0,1]; the shader maps 0 → brightnessMin (no/faded line)
// and 1 → brightnessMax (lit line center) with the already-tuned theme values, so the look
// stays in the optically-tuned band with no shader/intensity changes. Ring index space:
// 72 = full perimeter (edge 0 = 0..23 top→left, edge 1 = 24..47 bottom, edge 2 = 48..71
// right→top); index 0 = apex.
const LINE_START_CENTER = 6; // top-left edge, just below the apex
const LINE_CENTERS_START = [
  LINE_START_CENTER,
  LINE_START_CENTER,
  LINE_START_CENTER,
] as const;
// All three travel the SAME direction (clockwise = negative ring-index/s) at different speeds,
// so from the shared start they fan out into a spreading cluster (band 0 leads, band 2 trails)
// rather than crossing.
const LINE_VELOCITIES = [-3.302, -2.355, -1.636] as const;
// Each band's SIZE (total ring-index span) breathes slowly between 100% and 170% of one triangle
// edge (LEDS_PER_EDGE) at its own rate/phase, so the lines read large and their thickness
// varies over that range. Half the span is a solid bright core; the outer half tapers linearly.
const LINE_SIZE_MIN = LEDS_PER_EDGE * 1; // 100% of an edge
const LINE_SIZE_MAX = LEDS_PER_EDGE * 1.7; // 170% of an edge
const LINE_SIZE_MID = (LINE_SIZE_MIN + LINE_SIZE_MAX) / 2;
const LINE_SIZE_AMP = (LINE_SIZE_MAX - LINE_SIZE_MIN) / 2;
const LINE_SIZE_FREQ = [0.41, 0.31, 0.23] as const; // rad/s, slow, distinct from the fade
const LINE_SIZE_PHASE = [0, 2.1, 4.2] as const;
// Per-line slow intensity FADE in/out: each band's whole presence breathes between ~0 and 1 on
// its own slow period (≈12 s / 16.5 s / 22 s) and phase, so they fade independently. The phase
// is measured from the first frame (see updateLines), and band 0's phase = π/2 makes it fully
// lit at frame 0 — so the stacked start band is bright.
const LINE_FADE_FREQ = [0.52, 0.38, 0.28] as const; // rad/s
const LINE_FADE_PHASE = [Math.PI / 2, 0.4, -0.6] as const;
// Lines↔hover switch. A HARD distance threshold around the triangle (brush.linesFadeDistance ×
// triangleHeight, measured with the signed triangle SDF — negative inside) toggles between the
// ambient 'lines' animation and the pointer glow. Crossing it does NOT track the live mouse
// distance: it flips a latched target that a TEMPORAL crossfade (leds.hoverTransition) eases
// toward — the lines fade by (1 - hoverTransition) and the glow by hoverTransition, so they swap.
// LINES_HOVER_FADE_SECONDS is the crossfade time constant; LINES_HOVER_HYSTERESIS widens the exit
// threshold (× the enter threshold) so the latch doesn't dither right at the boundary.
const LINES_HOVER_FADE_SECONDS = 0.3;
const LINES_HOVER_HYSTERESIS = 1.2;

// 'lines2' mode: a variation of 'lines' where all three bands travel the SAME direction
// (clockwise = all negative) at different base speeds that drift slightly over time, and each
// band's WIDTH breathes smoothly (the peak brightness stays pinned at the tuned brightnessMax —
// the opposite emphasis from 'lines', which breathes brightness and holds width). Same
// coverage/[0,1] output, so the shader path and tuned intensities are untouched.
const LINE2_CENTERS_START = [0, 24, 48] as const; // spread: one band per corner to start
const LINE2_BASE_VELOCITIES = [-3.6, -5.1, -6.7] as const; // index/s, all clockwise; they overtake
// Each band's speed drifts by ±(amp) of its base over a slow period, out of phase per band.
const LINE2_VEL_MOD_AMP = [0.22, 0.18, 0.26] as const; // fraction of base velocity
const LINE2_VEL_MOD_FREQ = [0.18, 0.27, 0.21] as const; // rad/s (slow drift)
const LINE2_VEL_MOD_OFFSET = [0, 1.9, 3.7] as const;
// Smoothly breathing plateau width (LED counts) + fixed linear falloff per band.
const LINE2_BASE_WIDTH = [5, 4.2, 5.6] as const;
const LINE2_WIDTH_MOD_AMP = [2.2, 1.8, 2.6] as const; // ± LED counts
const LINE2_WIDTH_MOD_FREQ = [0.33, 0.41, 0.29] as const; // rad/s (slow breathe)
const LINE2_WIDTH_MOD_OFFSET = [0.5, 2.3, 4.1] as const;
const LINE2_FALLOFF = [6.5, 7, 6] as const;

interface LedPoint {
  x: number;
  y: number;
}

/**
 * Device-agnostic LED geometry + animation state — everything `computeLeds` reads/writes EXCEPT
 * the device-specific storage. The WebGPU renderer wraps this with a `buffer` (a storage buffer);
 * a WebGL renderer wraps it with an RGBA32F data texture instead. `computeLeds` and every per-frame
 * helper operate purely on this shape, so the CPU is shared verbatim across both backends.
 */
export interface LedGeometryState {
  data: Float32Array;
  currentState: Float32Array;
  targetState: Float32Array;
  deployingState: Float32Array;
  local: Float32Array;
  /** Per-LED outward edge normal (unit, 2 floats each), precomputed from the edge tangent and the
   *  radial sign. Used to weight the pointer-proximity glow so back-facing LEDs don't light up. */
  normals: Float32Array;
  ledRadius: number;
  triangleHeight: number;
  deployEdgeCenters: readonly [LedPoint, LedPoint, LedPoint];
  /** Triangle vertices (top, left, right) in sim space, for the CPU mouse-distance SDF. */
  triangleVertices: readonly [LedPoint, LedPoint, LedPoint];
  lastMode: HeroStateMode | undefined;
  lastEdgeIndex: number | undefined;
  transitionStart: number;
  transitionDuration: number;
  transitionActive: boolean;
  /** Accumulated, click-boosted animation time (seconds). Advances each frame by the
   *  per-frame delta × the click speed-boost, so every mode (coding rotation, lines bands,
   *  scan/pulse phase) accelerates together during a click. Seeded to
   *  NOISE_ROTATION_START_SECONDS on the first frame so the live hero starts at the same
   *  phase the static fallback bakes. */
  animationClock: number;
  /** Seconds of rendered time since the first frame (pause-aware: advances only by
   *  clamped frame deltas). Drives the rotation startup speed-boost decay. */
  startupElapsed: number;
  /** Wall-clock seconds of the previous frame, for the rotation delta time. */
  lastFrameTime: number | undefined;
  /** Per-line ring-index centers for the 'lines' mode (3 independent moving bands). */
  lineCenters: Float32Array;
  /** Per-line ring-index velocities (index/sec) for the 'lines' mode. */
  lineVelocities: Float32Array;
  /** Per-LED eased pointer-proximity glow factor [0,1], low-passed toward the proximity target
   *  each frame so the glow fades in/out and follows the pointer smoothly. */
  glowState: Float32Array;
  /** True while the glow buffer still has nonzero values to ease out after the mouse left. Lets
   *  the per-LED glow loop run ONLY when a mouse is present or the glow is still decaying — on
   *  touch/mobile (no real mouse) it never runs, so no per-frame compute is wasted. */
  glowDecaying: boolean;
  /** Temporal lines↔hover crossfade [0,1]: 0 = ambient 'lines' animation, 1 = pointer glow. Eased
   *  toward a latched HARD-threshold toggle (see LINES_HOVER_*) so crossing the threshold swaps the
   *  two over time, independent of the live mouse distance. */
  hoverTransition: number;
  /** Latched state of the lines↔hover threshold toggle (with hysteresis): true once the pointer
   *  crossed inside the enter threshold, false once it crossed back past the wider exit threshold. */
  hoverActive: boolean;
}

/**
 * WebGPU LED state: the shared geometry/animation state plus the storage buffer the simulation
 * passes read. `updateLeds` writes `data` into this buffer each frame.
 */
export interface LedBufferState extends LedGeometryState {
  buffer: Buffer;
}

export interface LedTransitionFrame {
  mode: HeroStateMode;
  modeChanged: boolean;
  progress: number;
  easedProgress: number;
  active: boolean;
}

export interface HoverDeployAnimationState {
  factor: number;
  elapsed: number;
  time: number;
  tint: Pick<
    HoverRgbTintSettings,
    | 'amount'
    | 'radius'
    | 'power'
    | 'deployDurationSeconds'
    | 'noiseBrightnessMin'
    | 'noiseBrightnessMax'
    | 'noiseBrightnessPower'
    | 'edgeRedLinear'
    | 'edgeGreenLinear'
    | 'edgeBlueLinear'
    | 'edgeOverlap'
  >;
}

/**
 * Builds the device-agnostic LED geometry + animation state for a given simulation size —
 * everything `computeLeds` needs EXCEPT the device-specific storage (the WebGPU storage buffer /
 * the WebGL data texture). Each renderer wraps this to allocate its own storage: WebGPU via
 * `createLedBuffer` (below), WebGL via its own data-texture allocator.
 *
 * The positions/geometry are size-dependent, so this is rebuilt whenever the sim size changes
 * (sim == canvas, so on every resize). Pass `previous` to carry the time-based ANIMATION state
 * across that rebuild — without it, a resize re-seeds `animationClock` to the bake start phase and
 * the animation visibly snaps back. The brightness/color are recomputed each frame from
 * `animationClock` (+ the moving `lineCenters`) + mode, so only the scalar animation phase needs
 * carrying; the in-flight mode transition is reset (its `currentState` snapshot can't survive a
 * geometry change), so a resize mid-transition just settles instantly.
 */
export function buildLedGeometry(
  size: RenderSize,
  previous?: LedGeometryState,
): LedGeometryState {
  const layout = triangleEdgeLedLayout(size, LEDS_PER_EDGE);
  const data = new Float32Array(layout.positions.length * LED_FLOATS);
  const currentState = new Float32Array(data.length);
  const targetState = new Float32Array(data.length);
  const deployingState = new Float32Array(data.length);
  const local = new Float32Array(layout.positions.length * 2);
  const normals = new Float32Array(layout.positions.length * 2);
  for (const [i, p] of layout.positions.entries()) {
    const base = i * LED_FLOATS;
    const x = p.x;
    const y = p.y;
    const angle = p.angle ?? 0;
    data[base + POS_BRIGHTNESS_OFFSET] = x;
    data[base + POS_BRIGHTNESS_OFFSET + 1] = y;
    data[base + POS_BRIGHTNESS_OFFSET + 2] = 0;
    data[base + POS_BRIGHTNESS_OFFSET + 3] = angle;
    data[base + COLOR_OFFSET] = 1;
    data[base + COLOR_OFFSET + 1] = 1;
    data[base + COLOR_OFFSET + 2] = 1;
    data[base + COLOR_OFFSET + 3] = 0;
    const rx = x - layout.center.x;
    const ry = y - layout.center.y;
    local[i * 2] = rx;
    local[i * 2 + 1] = ry;
    // Outward edge normal = edge tangent (angle) rotated 90°, with the sign that points away from
    // the triangle center (dot with the radial). Unit length since the tangent is.
    let nx = -Math.sin(angle);
    let ny = Math.cos(angle);
    if (nx * rx + ny * ry < 0) {
      nx = -nx;
      ny = -ny;
    }
    normals[i * 2] = nx;
    normals[i * 2 + 1] = ny;
  }
  currentState.set(data);
  targetState.set(data);
  deployingState.set(data);
  return {
    data,
    currentState,
    targetState,
    deployingState,
    local,
    normals,
    ledRadius: layout.ledRadius,
    triangleHeight: layout.geometry.height,
    deployEdgeCenters: [
      midpoint(layout.geometry.top, layout.geometry.left),
      midpoint(layout.geometry.left, layout.geometry.right),
      midpoint(layout.geometry.right, layout.geometry.top),
    ],
    triangleVertices: [
      { x: layout.geometry.top.x, y: layout.geometry.top.y },
      { x: layout.geometry.left.x, y: layout.geometry.left.y },
      { x: layout.geometry.right.x, y: layout.geometry.right.y },
    ],
    // Carried across a size-driven rebuild so the animation continues seamlessly
    // (see the doc comment). lastFrameTime must come along with animationClock: keeping it
    // defined is what stops computeLeds from treating the new buffer as a first frame and
    // re-seeding the clock to the bake start phase.
    lastMode: previous?.lastMode,
    lastEdgeIndex: previous?.lastEdgeIndex,
    transitionStart: 0,
    transitionDuration: 0,
    transitionActive: false,
    animationClock: previous?.animationClock ?? 0,
    startupElapsed: previous?.startupElapsed ?? 0,
    lastFrameTime: previous?.lastFrameTime,
    // Carried across resize so the moving lines don't snap (like the animation clock).
    lineCenters: previous?.lineCenters ?? Float32Array.from(LINE_CENTERS_START),
    lineVelocities:
      previous?.lineVelocities ?? Float32Array.from(LINE_VELOCITIES),
    // Carried across resize so the glow doesn't pop; sized to the (fixed) LED count.
    glowState: previous?.glowState ?? new Float32Array(LED_COUNT),
    glowDecaying: previous?.glowDecaying ?? false,
    hoverTransition: previous?.hoverTransition ?? 0,
    hoverActive: previous?.hoverActive ?? false,
  };
}

/**
 * WebGPU wrapper around {@link buildLedGeometry}: builds the shared geometry, then allocates the
 * storage buffer the simulation passes read and seeds it with the initial `data`.
 */
export function createLedBuffer(
  device: Device,
  size: RenderSize,
  previous?: LedBufferState,
): LedBufferState {
  const geometry = buildLedGeometry(size, previous);
  const buffer = device.createBuffer({
    size: geometry.data.byteLength,
    usage: ['storage', 'copy_dst'],
    label: 'triangle-led-4-leds',
  });
  // `data` carries an ArrayBuffer (never a SharedArrayBuffer); the interface's widened
  // Float32Array type loses that, so narrow it for the buffer write — same cast the per-frame
  // upload in `updateLeds` makes with `data.buffer as ArrayBuffer`.
  buffer.write(geometry.data.buffer as ArrayBuffer);
  return { ...geometry, buffer };
}

/**
 * Pure, device-agnostic per-frame LED simulation: fills `leds.data` (and the carried animation
 * scalars) for the given time/mode/pointer/theme. This is the SHARED CPU both renderers reuse
 * verbatim — it does NOT touch any GPU resource. The WebGPU path (`updateLeds`) calls this then
 * uploads `leds.data` to its storage buffer; a WebGL path calls this then `texSubImage`s the data
 * into its RGBA32F data texture.
 *
 * @remarks `theme` defaults to dark so existing callers/tests keep the unmodified behavior; it only
 * gates the light+colored active-edge brightness exception (see the edge case below).
 */
export function computeLeds(
  leds: LedGeometryState,
  time: number,
  tunables: SceneTunables,
  settings: HeroStateSettings,
  hoverDeploy?: HoverDeployAnimationState,
  // Pointer state for the proximity LED glow (LEDs near the pointer mix toward max brightness).
  brush?: BrushState,
  theme: 'dark' | 'light' = 'dark',
): LedTransitionFrame {
  let modeChanged = false;

  // Advance one shared animation clock by deltaTime (not absolute time) so changing a
  // speed never snaps the phase. The click "speed up": while the triangle is clicked the
  // smoothed deploy factor (0↔1) drives a boost — normal → CLICK_SPEED_BOOST_PEAK× → normal
  // across the transition (sin peaks at the midpoint, is 0 at both settled states), so the
  // boost tracks however long the transition takes. The boost multiplies the delta, so EVERY
  // mode reading this clock (coding rotation, the moving lines, scan/pulse phase) accelerates
  // together — not just the coding rotation.
  const isFirstFrame = leds.lastFrameTime === undefined;
  const frameDelta =
    leds.lastFrameTime === undefined
      ? 0
      : Math.max(0, Math.min(time - leds.lastFrameTime, MAX_NOISE_FRAME_DELTA));
  leds.lastFrameTime = time;
  const clickBoost =
    1 +
    (CLICK_SPEED_BOOST_PEAK - 1) *
      Math.sin(clamp01(hoverDeploy?.factor ?? 0) * Math.PI);
  const boostedDelta = frameDelta * clickBoost;
  // Startup boost (DISABLED): a fast burst that faded out to normal speed to mask the
  // static→canvas reveal. To re-enable: uncomment the block below, the two ROTATION_STARTUP_*
  // imports, and multiply `* startupBoost` into boostedDelta. `startupElapsed` is still tracked
  // below (real, unboosted seconds) so the decay works immediately when re-enabled.
  // const startupDecay = Math.exp(
  //   (-3 * leds.startupElapsed) / ROTATION_STARTUP_DURATION_SECONDS,
  // );
  // const startupBoost = 1 + (ROTATION_STARTUP_BOOST - 1) * startupDecay;
  if (isFirstFrame) {
    // Seed the clock NOISE_ROTATION_START_SECONDS in (boost = 1) so the live hero begins at
    // the same phase the static fallback bake renders — the canvas reveals over the static
    // seamlessly, whichever mode is the default.
    leds.animationClock = NOISE_ROTATION_START_SECONDS;
  }
  leds.animationClock += boostedDelta;
  leds.startupElapsed += frameDelta;
  const animTime = leds.animationClock;
  // Coding's rotation is just the shared clock × speed (mod 2π). Deriving it from the clock
  // keeps coding identical to the old per-frame accumulator while every other mode reads the
  // same clock.
  const codingRotation = (animTime * tunables.rotationSpeed) % TWO_PI;

  const edgeIndex = sanitizeEdgeIndex(settings.edgeIndex);
  const edgeIndexChanged =
    settings.mode === HERO_STATE_MODES.edge &&
    leds.lastEdgeIndex !== undefined &&
    edgeIndex !== leds.lastEdgeIndex;

  // Entering a mode = the first frame, or an actual mode switch (NOT a resize: createLedBuffer
  // carries lastMode + lineCenters, so isModeEntry is false there and the bands don't snap).
  const isModeEntry =
    leds.lastMode === undefined || settings.mode !== leds.lastMode;

  if (leds.lastMode === undefined) {
    leds.lastMode = settings.mode;
    leds.lastEdgeIndex = edgeIndex;
    leds.transitionActive = false;
  } else if (settings.mode !== leds.lastMode || edgeIndexChanged) {
    modeChanged = true;
    leds.currentState.set(leds.data);
    leds.transitionStart = time;
    leds.transitionDuration = Math.max(0, settings.transitionDuration);
    leds.transitionActive = leds.transitionDuration > 0;
    leds.lastMode = settings.mode;
    leds.lastEdgeIndex = edgeIndex;
  }

  // (Re)seed the band centers to the entered mode's start layout: 'lines' stacks them on the
  // top-left edge (they separate as they move); 'lines2' spreads one per corner.
  if (isModeEntry) {
    if (settings.mode === HERO_STATE_MODES.lines) {
      leds.lineCenters.set(LINE_CENTERS_START);
    } else if (settings.mode === HERO_STATE_MODES.lines2) {
      leds.lineCenters.set(LINE2_CENTERS_START);
    }
  }

  switch (settings.mode) {
    case HERO_STATE_MODES.scan:
      updateScan(
        leds,
        leds.targetState,
        animTime,
        settings.scanSpeed,
        settings.scanHeadWidth,
        settings.scanRedShift,
        settings.scanBlueShift,
        settings.scanHueRotationSpeed,
      );
      break;
    case HERO_STATE_MODES.pulse:
      updatePulse(
        leds,
        leds.targetState,
        animTime,
        settings.pulseSpeed,
        settings.pulseWidth,
      );
      break;
    case HERO_STATE_MODES.edge: {
      // Light + colored exception: as the colored floor reveals (colorFactor → 1, LIGHT theme only),
      // boost the highlighted edge up to EDGE_HIGHLIGHT_LIGHT_COLOR_BOOST× and dim the non-highlighted
      // edges to EDGE_INACTIVE_LIGHT_COLOR_SCALE×. Ramped by the color mix so it tracks the reveal;
      // no effect in grayscale (factor 0) or on the dark theme.
      const colorFactor =
        theme === 'light' ? clamp01(hoverDeploy?.factor ?? 0) : 0;
      const activeBoost =
        1 + (EDGE_HIGHLIGHT_LIGHT_COLOR_BOOST - 1) * colorFactor;
      const inactiveScale =
        1 - (1 - EDGE_INACTIVE_LIGHT_COLOR_SCALE) * colorFactor;
      updateEdge(
        leds.targetState,
        edgeIndex,
        // Non-highlighted edges sit at INACTIVE_EDGE_BRIGHTNESS_FACTOR of the (theme-aware) LED
        // brightness floor (× the light+colored inactiveScale) so they read much darker than the
        // fully-lit hovered edge.
        tunables.brightnessMin *
          INACTIVE_EDGE_BRIGHTNESS_FACTOR *
          inactiveScale,
        settings.edgeHighlightBrightness * activeBoost,
      );
      break;
    }
    case HERO_STATE_MODES.lines:
      updateLines(leds, leds.targetState, animTime, boostedDelta);
      break;
    case HERO_STATE_MODES.lines2:
      updateLines2(leds, leds.targetState, animTime, boostedDelta);
      break;
    case HERO_STATE_MODES.coding:
    default:
      updateCoding(leds, leds.targetState, codingRotation, tunables);
      break;
  }

  // Lines↔hover switch (lines modes only): see LINES_HOVER_* above. The glow is the APPROACH
  // effect — it engages only while the pointer is near the triangle but still OUTSIDE it (within
  // the HARD distance threshold, latched with hysteresis), crossfading the ambient lines out (by
  // 1 - hoverTransition) and the glow in (by hoverTransition) over time. Once the pointer is ON the
  // triangle (brush.inside) the toggle releases: the lines return and the triangle's own hover
  // effect (the lifted brightnessMin floor + click-deploy colors) takes over — no pointer glow on
  // top. A no-op (glow ungated, lines full) when linesFadeDistance is 0 or the mode isn't lines.
  const linesHoverToggleEnabled =
    (settings.mode === HERO_STATE_MODES.lines ||
      settings.mode === HERO_STATE_MODES.lines2) &&
    (brush?.linesFadeDistance ?? 0) > 0;
  let hoverTransition = 0;
  if (linesHoverToggleEnabled) {
    let hoverTarget = 0;
    // The toggle only engages with a real mouse, in the approach band OUTSIDE the triangle. Touch,
    // no pointer, or the pointer being inside the triangle all leave the target at 0 (lines).
    if (
      brush?.active === true &&
      brush.isMouse === true &&
      brush.inside !== true
    ) {
      const enter = (brush.linesFadeDistance ?? 0) * leds.triangleHeight;
      const v = leds.triangleVertices;
      const d = triangleSdf2D(brush.x, brush.y, v[0], v[1], v[2]);
      if (!leds.hoverActive && d < enter) leds.hoverActive = true;
      else if (leds.hoverActive && d > enter * LINES_HOVER_HYSTERESIS)
        leds.hoverActive = false;
      hoverTarget = leds.hoverActive ? 1 : 0;
    } else {
      leds.hoverActive = false;
    }
    // Ease the scalar crossfade toward the latched target (real seconds — the click speed-boost
    // must not affect it). Skipped once fully settled at lines with nothing pending, so idle/touch
    // frames do no work.
    if (leds.hoverTransition > 0.0001 || hoverTarget > 0) {
      const alpha =
        LINES_HOVER_FADE_SECONDS > 0
          ? 1 - Math.exp(-frameDelta / LINES_HOVER_FADE_SECONDS)
          : 1;
      leds.hoverTransition += (hoverTarget - leds.hoverTransition) * alpha;
    }
    hoverTransition = clamp01(leds.hoverTransition);
    if (hoverTransition > 0.0001) {
      const linesFade = 1 - hoverTransition;
      for (let i = 0; i < LED_COUNT; i++) {
        leds.targetState[i * LED_FLOATS + 2] *= linesFade;
      }
    }
  } else if (leds.hoverTransition !== 0 || leds.hoverActive) {
    // Toggle off (mode change or distance set to 0): drop any in-progress crossfade so the glow
    // ungates immediately and the lines return to full.
    leds.hoverTransition = 0;
    leds.hoverActive = false;
  }

  let progress = 1;
  let easedProgress = 1;
  if (leds.transitionActive) {
    progress = clamp01((time - leds.transitionStart) / leds.transitionDuration);
    easedProgress = easeInQuad(progress);
    lerpLedState(leds.data, leds.currentState, leds.targetState, easedProgress);
    if (progress >= 1) leds.transitionActive = false;
  } else {
    leds.data.set(leds.targetState);
  }

  const hoverFactor = clamp01(hoverDeploy?.factor ?? 0);
  if (hoverFactor > 0) {
    updateDeployingRgb(leds, leds.deployingState, hoverDeploy?.tint);
    lerpLedState(leds.data, leds.data, leds.deployingState, hoverFactor);
  }

  // Pointer-proximity glow (smoothed, MOUSE-ONLY): each frame, ease a per-LED glow factor
  // (leds.glowState) toward its proximity target, then mix the LED coverage toward max brightness
  // (1) by it. Per-LED easing makes the glow fade in/out and follow the pointer smoothly.
  // PERFORMANCE: the loop runs ONLY when a real mouse is present (brush.isMouse) or the glow is
  // still easing out (glowDecaying). On touch/mobile there is no mouse, so this never runs and
  // wastes no per-frame compute. Applied last so it lifts the final per-LED brightness.
  // The glow's overall presence is gated by the lines↔hover crossfade (hoverTransition) so it
  // switches in as the lines fade out; outside the lines-toggle (other modes / distance 0) the
  // gate is 1 and the glow behaves purely by proximity. glowState still tracks the pointer while
  // gated to 0, so when the toggle crosses in the glow is already positioned (no spatial lag).
  const hoverGate = linesHoverToggleEnabled ? hoverTransition : 1;
  const glowStrength = brush?.glowStrength ?? 0;
  const glowRadius = brush?.glowRadius ?? 0;
  const glowOn =
    brush?.active === true &&
    brush.isMouse === true &&
    brush.glowEnabled === true &&
    glowStrength > 0 &&
    glowRadius > 0;
  if (glowOn || leds.glowDecaying) {
    const glowSmoothing = brush?.glowSmoothing ?? 0;
    const glowAlpha =
      glowSmoothing > 0 ? 1 - Math.exp(-frameDelta / glowSmoothing) : 1;
    const px = brush?.x ?? 0;
    const py = brush?.y ?? 0;
    // Back-face cull: scale each LED's glow target by how much its outward normal faces the
    // pointer. cos of the cutoff angles → a soft ramp full at facingFullDeg, 0 at facingZeroDeg.
    const facingOn = brush?.glowFacingEnabled === true;
    const facingCosFull = Math.cos(
      ((brush?.glowFacingFullDeg ?? 90) * Math.PI) / 180,
    );
    const facingCosZero = Math.cos(
      ((brush?.glowFacingZeroDeg ?? 100) * Math.PI) / 180,
    );
    const facingDenom = facingCosFull - facingCosZero;
    let anyActive = false;
    for (let i = 0; i < LED_COUNT; i++) {
      const base = i * LED_FLOATS;
      let target = 0;
      if (glowOn) {
        const dx = (leds.data[base + POS_BRIGHTNESS_OFFSET] ?? 0) - px;
        const dy = (leds.data[base + POS_BRIGHTNESS_OFFSET + 1] ?? 0) - py;
        const dist = Math.hypot(dx, dy);
        target = glowStrength * (1 - smoothstep(0, glowRadius, dist));
        if (facingOn && target > 0 && dist > 1e-4) {
          // cos of the angle between the LED's outward normal and the direction TO the pointer
          // (-dx, -dy is LED→pointer). 1 = facing the pointer, -1 = facing dead away.
          const cos =
            (leds.normals[i * 2] ?? 0) * (-dx / dist) +
            (leds.normals[i * 2 + 1] ?? 0) * (-dy / dist);
          const facing =
            facingDenom > 1e-6
              ? clamp01((cos - facingCosZero) / facingDenom)
              : cos >= facingCosFull
                ? 1
                : 0;
          target *= facing;
        }
      }
      const eased =
        (leds.glowState[i] ?? 0) +
        (target - (leds.glowState[i] ?? 0)) * glowAlpha;
      leds.glowState[i] = eased;
      if (eased > 0.0001) {
        anyActive = true;
        const lift = eased * hoverGate;
        if (lift > 0.0001)
          leds.data[base + 2] = mix(leds.data[base + 2] ?? 0, 1, lift); // brightness slot
      }
    }
    // Keep running next frame only while the mouse is here or values are still easing out.
    leds.glowDecaying = glowOn || anyActive;
  }

  return {
    mode: settings.mode,
    modeChanged,
    progress,
    easedProgress,
    active: leds.transitionActive,
  };
}

/**
 * WebGPU back-compat wrapper: runs the shared {@link computeLeds} CPU simulation, then uploads the
 * filled `leds.data` to the storage buffer the simulation passes read.
 */
export function updateLeds(
  device: Device,
  leds: LedBufferState,
  time: number,
  tunables: SceneTunables,
  settings: HeroStateSettings,
  hoverDeploy?: HoverDeployAnimationState,
  brush?: BrushState,
  theme: 'dark' | 'light' = 'dark',
): LedTransitionFrame {
  const transition = computeLeds(
    leds,
    time,
    tunables,
    settings,
    hoverDeploy,
    brush,
    theme,
  );
  device.queue.writeBuffer(leds.buffer.gpu, 0, leds.data.buffer as ArrayBuffer);
  return transition;
}

function updateDeployingRgb(
  leds: LedGeometryState,
  target: Float32Array,
  tint: HoverDeployAnimationState['tint'] | undefined,
) {
  target.set(leds.data);
  for (let i = 0; i < LED_COUNT; i++) {
    const color = edgeTintColor(leds, i, tint);
    writeLedColor(target, i, color.r, color.g, color.b);
  }
}

function relativeLuminance(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

// Scales a colour so its luminance is exactly 1, matching the white LED. Channel
// ratios (hue/chroma) are preserved; near-black inputs are left untouched. This
// makes colored edges reach as far as the white light instead of glowing dimmer.
function normalizeLuminance(r: number, g: number, b: number) {
  const lum = relativeLuminance(r, g, b);
  if (lum <= 1e-4) return { r, g, b };
  const scale = 1 / lum;
  return { r: r * scale, g: g * scale, b: b * scale };
}

function edgeTintColor(
  leds: LedGeometryState,
  i: number,
  tint: HoverDeployAnimationState['tint'] | undefined,
) {
  const amount = clamp01(tint?.amount ?? 1);
  const radius = Math.max(tint?.radius ?? 1, 1);
  const power = Math.max(tint?.power ?? 1, 0.001);
  // Per-edge LINEAR colors come from the tint (GUI-editable); fall back to the module constants
  // when no tint is supplied. Defaults equal these constants, so the look is unchanged by default.
  const red = tint?.edgeRedLinear ?? EDGE_RED_LINEAR;
  const green = tint?.edgeGreenLinear ?? EDGE_GREEN_LINEAR;
  const blue = tint?.edgeBlueLinear ?? EDGE_BLUE_LINEAR;
  const base = i * LED_FLOATS;
  const x = leds.data[base + POS_BRIGHTNESS_OFFSET] ?? 0;
  const y = leds.data[base + POS_BRIGHTNESS_OFFSET + 1] ?? 0;
  const [redCenter, greenCenter, blueCenter] = leds.deployEdgeCenters;
  // Overlap control: raise the per-edge weights to 1/overlap before normalizing. overlap 1 →
  // unchanged; <1 sharpens (each LED dominated by its nearest edge → less color mixing); >1
  // softens (more mixing between edges).
  const invOverlap = 1 / Math.max(tint?.edgeOverlap ?? 1, 0.01);
  const wr =
    edgeWeight(x, y, redCenter.x, redCenter.y, radius, power) ** invOverlap;
  const wg =
    edgeWeight(x, y, greenCenter.x, greenCenter.y, radius, power) ** invOverlap;
  const wb =
    edgeWeight(x, y, blueCenter.x, blueCenter.y, radius, power) ** invOverlap;
  const sum = Math.max(wr + wg + wb, 0.0001);
  const r = (red.r * wr + green.r * wg + blue.r * wb) / sum;
  const g = (red.g * wr + green.g * wg + blue.g * wb) / sum;
  const b = (red.b * wr + green.b * wg + blue.b * wb) / sum;
  // Normalize the blended edge colour to luminance 1 so it reaches as far as the
  // white light. White is also luminance 1, so the amount-mix below stays at
  // luminance 1 for any tint amount.
  const tinted = normalizeLuminance(r, g, b);
  return {
    r: mix(1, tinted.r, amount),
    g: mix(1, tinted.g, amount),
    b: mix(1, tinted.b, amount),
  };
}

function edgeWeight(
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
  power: number,
) {
  return (1 / (1 + Math.hypot(x - cx, y - cy) / radius)) ** power;
}

function midpoint(a: LedPoint, b: LedPoint) {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

// Signed distance from point p to triangle (a,b,c) — IQ's 2D triangle SDF. Negative inside,
// 0 on an edge, positive outside (same units as the inputs). Used to fade the 'lines' animation
// by how far the mouse is from the triangle.
function triangleSdf2D(
  px: number,
  py: number,
  a: LedPoint,
  b: LedPoint,
  c: LedPoint,
): number {
  const e0x = b.x - a.x;
  const e0y = b.y - a.y;
  const e1x = c.x - b.x;
  const e1y = c.y - b.y;
  const e2x = a.x - c.x;
  const e2y = a.y - c.y;
  const v0x = px - a.x;
  const v0y = py - a.y;
  const v1x = px - b.x;
  const v1y = py - b.y;
  const v2x = px - c.x;
  const v2y = py - c.y;
  const t0 = clamp01((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y || 1));
  const t1 = clamp01((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y || 1));
  const t2 = clamp01((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y || 1));
  const p0x = v0x - e0x * t0;
  const p0y = v0y - e0y * t0;
  const p1x = v1x - e1x * t1;
  const p1y = v1y - e1y * t1;
  const p2x = v2x - e2x * t2;
  const p2y = v2y - e2y * t2;
  const s = Math.sign(e0x * e2y - e0y * e2x);
  // Component-wise min of (distance², signed area) across the three edges (IQ's trick).
  const dist2 = Math.min(
    p0x * p0x + p0y * p0y,
    p1x * p1x + p1y * p1y,
    p2x * p2x + p2y * p2y,
  );
  const sgn = Math.min(
    s * (v0x * e0y - v0y * e0x),
    s * (v1x * e1y - v1y * e1x),
    s * (v2x * e2y - v2y * e2x),
  );
  return -Math.sqrt(dist2) * Math.sign(sgn);
}

/**
 * Reference triangle height (sim px) the coding-noise frequency is calibrated against — the
 * triangle at the desktop-cap canvas, zoom 1. The noise is sampled at LED positions scaled by
 * (this / actual triangleHeight), so the pattern stays a fixed FRACTION of the triangle —
 * proportional at any canvas height / camera zoom — instead of a fixed frequency in pixels
 * (which made the noise read larger on shorter canvases). At this reference size the look is
 * unchanged from the previous absolute-pixel behavior.
 */
const NOISE_REFERENCE_TRIANGLE_HEIGHT =
  HERO_CANVAS_MAX_CSS * TRIANGLE_HEIGHT_RATIO;

function updateCoding(
  leds: LedGeometryState,
  target: Float32Array,
  rotation: number,
  tunables: SceneTunables,
) {
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const freq =
    (tunables.noiseScale * NOISE_REFERENCE_TRIANGLE_HEIGHT) /
    Math.max(leds.triangleHeight, 1e-3);
  for (let i = 0; i < leds.local.length / 2; i++) {
    const x = leds.local[i * 2] ?? 0;
    const y = leds.local[i * 2 + 1] ?? 0;
    const rx = (x * cosR - y * sinR) * freq;
    const ry = (x * sinR + y * cosR) * freq;
    writeLed(target, i, clamp01(valueNoise2D(rx, ry) + 0.5), 1, 1, 1);
  }
}

function updateScan(
  leds: LedGeometryState,
  target: Float32Array,
  time: number,
  speed: number,
  headWidth: number,
  redShift: number,
  blueShift: number,
  hueRotationSpeed: number,
) {
  const headPos = fract(time * speed) * LED_COUNT;
  const width = Math.max(0.001, headWidth);
  const huePhase = fract(time * hueRotationSpeed);
  hslToRgb(SCAN_RED_ENDPOINT, huePhase, 1, 0.5);
  hslToRgb(SCAN_BLUE_ENDPOINT, fract(huePhase + 2 / 3), 1, 0.5);

  for (let i = 0; i < LED_COUNT; i++) {
    const signedOffset = signedWrappedDistance(i, headPos, LED_COUNT);
    const d = Math.abs(signedOffset);
    const envelope = smoothstep(width, 0, d);
    const brightness = Math.max(envelope, PULSE_FLOOR);
    const tintMask = smoothstep(0.001, 0.05, envelope);
    const local = clamp01(signedOffset / width / 2 + 0.5) * 2 - 1;
    const redSide = Math.sqrt(Math.max(0, -local));
    const blueSide = Math.sqrt(Math.max(0, local));
    const redStrength = clamp01(redShift) * redSide;
    const blueStrength = clamp01(blueShift) * blueSide;

    let r = mix(1, SCAN_RED_ENDPOINT[0] ?? 1, redStrength);
    let g = mix(1, SCAN_RED_ENDPOINT[1] ?? 1, redStrength);
    let b = mix(1, SCAN_RED_ENDPOINT[2] ?? 1, redStrength);
    r = mix(r, SCAN_BLUE_ENDPOINT[0] ?? 1, blueStrength);
    g = mix(g, SCAN_BLUE_ENDPOINT[1] ?? 1, blueStrength);
    b = mix(b, SCAN_BLUE_ENDPOINT[2] ?? 1, blueStrength);

    writeLed(
      target,
      i,
      brightness,
      mix(1, r, tintMask),
      mix(1, g, tintMask),
      mix(1, b, tintMask),
    );
  }
}

function updatePulse(
  leds: LedGeometryState,
  target: Float32Array,
  time: number,
  speed: number,
  width: number,
) {
  const progress = fract(time * speed);
  const pulseCenterCount = pulseCentersForProgress(progress);
  const sigma = Math.max(0.001, width);

  for (let i = 0; i < LED_COUNT; i++) {
    let brightness = PULSE_FLOOR;
    for (let j = 0; j < pulseCenterCount; j++) {
      const center = PULSE_CENTERS_SCRATCH[j] ?? 0;
      const d = wrappedDistance(i, center, LED_COUNT);
      brightness = Math.max(brightness, Math.exp(-((d / sigma) ** 2)));
    }
    writeLed(target, i, clamp01(brightness), 1, 1, 1);
  }
}

/**
 * 'lines' mode: three bright bands on the 72-LED perimeter ring. They begin STACKED at
 * LINE_START_CENTER (seeded on mode entry, see updateLeds) — so the first frame is a single
 * band over the top-left edge — then separate as each moves at its own speed/direction. Each
 * band also fades its whole intensity in and out slowly (LINE_FADE_*), at its own rate and
 * phase, so they pulse independently. Each LED takes the MAX over the 3 bands of
 * profile × fade (plateau + linear falloff, like the original), so overlaps stay bounded. The
 * coverage (0..1) is written as the LED brightness; the shader maps 0 → brightnessMin and
 * 1 → brightnessMax with the already-tuned theme values, so the look stays in that band.
 */
function updateLines(
  leds: LedGeometryState,
  target: Float32Array,
  // Shared, click-boosted animation clock + per-frame delta — so the bands accelerate with
  // the click speed-up exactly like every other mode.
  animTime: number,
  boostedDelta: number,
) {
  for (let k = 0; k < 3; k++) {
    leds.lineCenters[k] = wrapIndex(
      (leds.lineCenters[k] ?? 0) + (leds.lineVelocities[k] ?? 0) * boostedDelta,
    );
  }
  // Fade/size time is measured from the first frame (clock seeded at NOISE_ROTATION_START_SECONDS),
  // so the LINE_FADE_PHASE values land as authored on frame 0 (band 0 fully lit).
  const fadeTime = animTime - NOISE_ROTATION_START_SECONDS;
  // The band size + fade depend only on the band (k) and fadeTime, NOT the LED index, so hoist
  // their 6 Math.sin out of the 72-LED loop (was 432 sin/frame in the default 'lines' mode). The
  // per-band half/plateau/fade values are identical to the old per-LED computation → bit-exact.
  const halfByBand: number[] = [];
  const plateauByBand: number[] = [];
  const fadeByBand: number[] = [];
  for (let k = 0; k < 3; k++) {
    // Slowly breathing band size (total span), 50%..90% of an edge → half-span each side.
    const size =
      LINE_SIZE_MID +
      LINE_SIZE_AMP *
        Math.sin(
          fadeTime * (LINE_SIZE_FREQ[k] ?? 0) + (LINE_SIZE_PHASE[k] ?? 0),
        );
    const half = Math.max(1, size * 0.5);
    halfByBand[k] = half;
    plateauByBand[k] = half * 0.5; // inner half is solid bright, outer half tapers
    // Slow per-line fade in/out (0..1): the whole band breathes its intensity on its own
    // period/phase, so the 3 bands fade independently. Stays ≤ 1 → ≤ brightnessMax.
    fadeByBand[k] =
      0.5 +
      0.5 *
        Math.sin(
          fadeTime * (LINE_FADE_FREQ[k] ?? 0) + (LINE_FADE_PHASE[k] ?? 0),
        );
  }
  for (let i = 0; i < LED_COUNT; i++) {
    let coverage = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(
        signedWrappedDistance(i, leds.lineCenters[k] ?? 0, LED_COUNT),
      );
      const half = halfByBand[k] ?? 1;
      const plateauRadius = plateauByBand[k] ?? 0;
      let profile = 0;
      if (d <= plateauRadius) {
        profile = 1;
      } else {
        profile = clamp01(1 - (d - plateauRadius) / (half - plateauRadius));
      }
      coverage = Math.max(coverage, profile * (fadeByBand[k] ?? 0));
    }
    writeLed(target, i, clamp01(coverage), 1, 1, 1);
  }
}

/**
 * 'lines2' mode: three bands all traveling the SAME direction (clockwise) at different base
 * speeds that drift slightly over time, each with a smoothly breathing WIDTH. Peak coverage
 * stays at 1 (the tuned brightnessMax); only the band thickness and speed vary. Same
 * coverage/max-combine + [0,1] output as 'lines', so no shader/intensity changes.
 */
function updateLines2(
  leds: LedGeometryState,
  target: Float32Array,
  animTime: number,
  boostedDelta: number,
) {
  for (let k = 0; k < 3; k++) {
    // Base speed × a slow ±amp drift, out of phase per band → they keep overtaking each other.
    const velocity =
      (LINE2_BASE_VELOCITIES[k] ?? 0) *
      (1 +
        (LINE2_VEL_MOD_AMP[k] ?? 0) *
          Math.sin(
            (animTime + (LINE2_VEL_MOD_OFFSET[k] ?? 0)) *
              (LINE2_VEL_MOD_FREQ[k] ?? 0),
          ));
    leds.lineCenters[k] = wrapIndex(
      (leds.lineCenters[k] ?? 0) + velocity * boostedDelta,
    );
  }
  for (let i = 0; i < LED_COUNT; i++) {
    let coverage = 0;
    for (let k = 0; k < 3; k++) {
      // Smoothly breathing plateau width (≥1 LED).
      const width = Math.max(
        1,
        (LINE2_BASE_WIDTH[k] ?? 0) +
          (LINE2_WIDTH_MOD_AMP[k] ?? 0) *
            Math.sin(
              (animTime + (LINE2_WIDTH_MOD_OFFSET[k] ?? 0)) *
                (LINE2_WIDTH_MOD_FREQ[k] ?? 0),
            ),
      );
      const plateauRadius = (width - 1) * 0.5;
      const d = Math.abs(
        signedWrappedDistance(i, leds.lineCenters[k] ?? 0, LED_COUNT),
      );
      const falloff = LINE2_FALLOFF[k] ?? 0;
      let profile = 0;
      if (d <= plateauRadius) {
        profile = 1;
      } else if (falloff > 0) {
        profile = clamp01(1 - (d - plateauRadius) / falloff);
      }
      coverage = Math.max(coverage, profile);
    }
    writeLed(target, i, clamp01(coverage), 1, 1, 1);
  }
}

function updateEdge(
  target: Float32Array,
  edgeIndex: number,
  baseBrightness: number,
  highlightBrightness: number,
) {
  const start = edgeIndex * LEDS_PER_EDGE;
  const end = start + LEDS_PER_EDGE;
  const base = clamp01(baseBrightness);
  const highlight = clamp01(highlightBrightness);

  for (let i = 0; i < LED_COUNT; i++) {
    writeLed(target, i, i >= start && i < end ? highlight : base, 1, 1, 1);
  }
}

function pulseCentersForProgress(progress: number) {
  if (progress < PULSE_VERTEX_HOLD_END || progress >= PULSE_ROTATE_END) {
    PULSE_CENTERS_SCRATCH[0] = PULSE_VERTICES[0];
    PULSE_CENTERS_SCRATCH[1] = PULSE_VERTICES[1];
    PULSE_CENTERS_SCRATCH[2] = PULSE_VERTICES[2];
    return 3;
  }

  if (progress < PULSE_SPLIT_END) {
    const t = easeInOutCubic(
      (progress - PULSE_VERTEX_HOLD_END) /
        (PULSE_SPLIT_END - PULSE_VERTEX_HOLD_END),
    );
    const offset = PULSE_HALF_EDGE * t;
    PULSE_CENTERS_SCRATCH[0] = wrapIndex(PULSE_VERTICES[0] + offset);
    PULSE_CENTERS_SCRATCH[1] = wrapIndex(PULSE_VERTICES[0] - offset);
    PULSE_CENTERS_SCRATCH[2] = wrapIndex(PULSE_VERTICES[1] - offset);
    PULSE_CENTERS_SCRATCH[3] = wrapIndex(PULSE_VERTICES[1] + offset);
    PULSE_CENTERS_SCRATCH[4] = wrapIndex(PULSE_VERTICES[2] - offset);
    PULSE_CENTERS_SCRATCH[5] = wrapIndex(PULSE_VERTICES[2] + offset);
    return 6;
  }

  if (progress < PULSE_MIDPOINT_HOLD_END) {
    PULSE_CENTERS_SCRATCH[0] = PULSE_MIDPOINTS[0];
    PULSE_CENTERS_SCRATCH[1] = PULSE_MIDPOINTS[1];
    PULSE_CENTERS_SCRATCH[2] = PULSE_MIDPOINTS[2];
    return 3;
  }

  const t = easeOutQuart(
    (progress - PULSE_MIDPOINT_HOLD_END) /
      (PULSE_ROTATE_END - PULSE_MIDPOINT_HOLD_END),
  );
  const offset = PULSE_ROTATE_DIRECTION * PULSE_HALF_EDGE * t;
  PULSE_CENTERS_SCRATCH[0] = wrapIndex(PULSE_MIDPOINTS[0] + offset);
  PULSE_CENTERS_SCRATCH[1] = wrapIndex(PULSE_MIDPOINTS[1] + offset);
  PULSE_CENTERS_SCRATCH[2] = wrapIndex(PULSE_MIDPOINTS[2] + offset);
  return 3;
}

function lerpLedState(
  target: Float32Array,
  from: Float32Array,
  to: Float32Array,
  t: number,
) {
  for (let i = 0; i < target.length; i++) {
    const a = from[i] ?? 0;
    target[i] = a + ((to[i] ?? 0) - a) * t;
  }
}

function writeLed(
  target: Float32Array,
  i: number,
  brightness: number,
  r: number,
  g: number,
  b: number,
) {
  const base = i * LED_FLOATS;
  target[base + 2] = brightness;
  target[base + COLOR_OFFSET] = r;
  target[base + COLOR_OFFSET + 1] = g;
  target[base + COLOR_OFFSET + 2] = b;
}

function writeLedColor(
  target: Float32Array,
  i: number,
  r: number,
  g: number,
  b: number,
) {
  const base = i * LED_FLOATS;
  target[base + COLOR_OFFSET] = r;
  target[base + COLOR_OFFSET + 1] = g;
  target[base + COLOR_OFFSET + 2] = b;
}

function hslToRgb(target: Float32Array, h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  target[0] = hslChannel(h, a, l, 0);
  target[1] = hslChannel(h, a, l, 8);
  target[2] = hslChannel(h, a, l, 4);
}

function hslChannel(h: number, a: number, l: number, n: number) {
  const k = (n + h * 12) % 12;
  return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
}

function fract(value: number) {
  return value - Math.floor(value);
}

function wrappedDistance(a: number, b: number, period: number) {
  const d = Math.abs(a - b);
  return Math.min(d, period - d);
}

function signedWrappedDistance(a: number, b: number, period: number) {
  return ((((a - b) % period) + period + period / 2) % period) - period / 2;
}

function wrapIndex(value: number) {
  return ((value % LED_COUNT) + LED_COUNT) % LED_COUNT;
}

function sanitizeEdgeIndex(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(2, Math.round(value)));
}

function easeInOutCubic(t: number) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function easeInQuad(t: number) {
  const x = clamp01(t);
  return x * x;
}

function easeOutQuart(t: number) {
  const x = clamp01(t);
  return 1 - (1 - x) ** 4;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

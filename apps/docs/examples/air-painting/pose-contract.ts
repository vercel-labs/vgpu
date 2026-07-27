/**
 * Frozen contract for the air-painting example.
 *
 * Everything in this module is pure TypeScript with no GPU, DOM, or ORT
 * dependency, so it is shared unchanged by the browser runtime, the ORT-free
 * Node thumbnail, and the unit tests. It is also the interface the VISUAL owner
 * codes against: change a constant or a transform here and every consumer moves
 * together.
 *
 * Coordinate spaces, once, so nothing has to guess:
 *
 * 1. `model` — what MoveNet sees. A 192x192 uint8 NHWC RGB letterbox of the
 *    **un-mirrored** camera frame. Output keypoints are normalized to this
 *    letterboxed square, including the black padding.
 * 2. `source` — the camera frame, normalized to [0,1]^2, no padding, not
 *    mirrored.
 * 3. `brush` — `source` mirrored on x. This is the selfie view the user sees, so
 *    it is the space brush state, the paint mask and the compositor all use.
 *
 * The model is fed the un-mirrored frame on purpose: MoveNet infers anatomical
 * left/right from appearance, so mirroring the input would silently swap the
 * wrists and index 10 would stop being the user's right hand.
 */

/** Same-origin model asset; see public/models/movenet/PROVENANCE.md. */
export const MODEL_URL = '/models/movenet/movenet-lightning.onnx';
export const MODEL_SHA256 = '0f4ca5f5049e8b43ee976f25f05f3455aa0cc66cafb50bc5f378b68a558a684b';
export const MODEL_BYTES = 9_402_989;
/** Graph I/O names of the converted MoveNet Lightning, used when a session omits them. */
export const MODEL_INPUT_NAME = 'serving_default_input:0';
export const MODEL_OUTPUT_NAME = 'StatefulPartitionedCall:0';

/**
 * The converted graph takes **uint8**, not the int32 the public model card
 * claims. Measured on the graph and confirmed by ORT at runtime:
 * `Unexpected input data type. Actual: (tensor(int32)), expected: (tensor(uint8))`.
 */
export const MODEL_INPUT_DTYPE = 'uint8' as const;
/** Square letterbox side in model pixels. */
export const MODEL_INPUT_SIZE = 192;
/** NHWC RGB element count: 192 * 192 * 3. */
export const MODEL_INPUT_ELEMENTS = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3;
export const MODEL_INPUT_DIMS = [1, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, 3] as const;

/** Output is float32 `[1, 1, 17, 3]`, each keypoint `[y, x, score]`. */
export const KEYPOINT_COUNT = 17;
export const KEYPOINT_STRIDE = 3;
export const KEYPOINT_DIMS = [1, 1, KEYPOINT_COUNT, KEYPOINT_STRIDE] as const;
export const KEYPOINT_ELEMENTS = KEYPOINT_COUNT * KEYPOINT_STRIDE;
/** 204 bytes of payload. ORT hands out a 256-byte buffer; both are accepted. */
export const KEYPOINT_BYTES = KEYPOINT_ELEMENTS * 4;
/**
 * The buffer size fixtures allocate, chosen to match what ORT actually returns
 * on real hardware so the bind group layout is identical in every mode.
 */
export const KEYPOINT_BUFFER_BYTES = 256;

/** COCO keypoint order, as documented by the MoveNet model card. */
export const KEYPOINT_NAMES = [
  'nose',
  'left-eye',
  'right-eye',
  'left-ear',
  'right-ear',
  'left-shoulder',
  'right-shoulder',
  'left-elbow',
  'right-elbow',
  'left-wrist',
  'right-wrist',
  'left-hip',
  'right-hip',
  'left-knee',
  'right-knee',
  'left-ankle',
  'right-ankle',
] as const;

export const LEFT_WRIST_INDEX = 9;
/** v1 always paints with the right wrist; picking the highest wrist would jump across the body. */
export const RIGHT_WRIST_INDEX = 10;

/**
 * Persistent paint mask, in `brush` space. Fixed logical size so strokes survive
 * canvas resize and DPR changes and the memory cost is bounded and known.
 */
export const MASK_WIDTH = 960;
export const MASK_HEIGHT = 540;
export const MASK_TEXELS = MASK_WIDTH * MASK_HEIGHT;
/** One f32 of coverage per texel: 2,073,600 bytes. */
export const MASK_BYTES = MASK_TEXELS * 4;

/**
 * `BrushState` storage layout, in f32 slots. WGSL sees this as a struct; the
 * host only ever writes zeros to it, so the two views only have to agree on the
 * total size.
 *
 * ```wgsl
 * struct BrushState {
 *   prev: vec2f,        // slots 0,1
 *   current: vec2f,     // slots 2,3
 *   confidence: f32,    // slot 4
 *   tracking: f32,      // slot 5 (`active` is a WGSL reserved keyword)
 *   invalid: f32,       // slot 6
 *   has_prev: f32,      // slot 7
 *   stroke: f32,        // slot 8
 *   strokes: f32,       // slot 9
 * }
 * ```
 */
export const BRUSH_STATE_SLOTS = 10;
/** Padded to 64 bytes: comfortably above the 40-byte struct and a nice alignment. */
export const BRUSH_STATE_BYTES = 64;

/** Fixed v1 tuning. Deliberately constants, not controls; there is no selector. */
export interface BrushTuning {
  /** Confidence needed to start painting. */
  readonly enterConfidence: number;
  /** Confidence needed to keep painting once active (hysteresis). */
  readonly stayConfidence: number;
  /** Time constant of the position EMA, in seconds. */
  readonly emaTauSeconds: number;
  /** Largest accepted step between results, as a fraction of the brush-space diagonal. */
  readonly maxJumpFraction: number;
  /** Consecutive invalid results that drop the active pose. */
  readonly invalidResetCount: number;
  /** Capsule radius in mask texels. */
  readonly radiusTexels: number;
  /** Coverage ramp width in mask texels. */
  readonly featherTexels: number;
}

export const BRUSH_TUNING: BrushTuning = {
  enterConfidence: 0.45,
  stayConfidence: 0.3,
  emaTauSeconds: 0.075,
  maxJumpFraction: 0.18,
  invalidResetCount: 2,
  // A touch bolder than the geometry needs, with a feather barely wider than one
  // texel: the mask carries just enough ramp for the compositor to antialias
  // against, so a stroke lands as confident ink rather than a soft airbrushed
  // blob. Widening the feather instead of the radius is what made it look fuzzy.
  radiusTexels: 10,
  featherTexels: 1.1,
};

/** Diagonal of the unit brush square; the jump cap is a fraction of it. */
export const BRUSH_SPACE_DIAGONAL = Math.SQRT2;

/** Absolute jump cap in brush units, precomputed for the uniform. */
export function maxJumpDistance(tuning: BrushTuning = BRUSH_TUNING): number {
  return tuning.maxJumpFraction * BRUSH_SPACE_DIAGONAL;
}

/**
 * dt is clamped so a backgrounded tab cannot teleport the brush with one huge
 * step. Keep in sync with `wrist.wgsl`, which is asserted by the unit tests.
 */
export const MAX_SMOOTHING_DT = 0.1;

/** Time-aware EMA weight. Identical expression to `wrist.wgsl`. */
export function smoothingAlpha(dtSeconds: number, tauSeconds = BRUSH_TUNING.emaTauSeconds): number {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_SMOOTHING_DT);
  return 1 - Math.exp(-dt / Math.max(tauSeconds, 1e-4));
}

/**
 * Aspect-preserving letterbox of a camera frame into the 192x192 model square.
 *
 * Forward:  `modelPx = sourcePx * scale + pad`
 * Inverse:  `sourcePx = (modelPx - pad) / scale`
 */
export interface FrameTransform {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Uniform scale from source pixels to model pixels. */
  readonly scale: number;
  /** Left padding in model pixels. */
  readonly padX: number;
  /** Top padding in model pixels. */
  readonly padY: number;
  /** Scaled frame width in model pixels. */
  readonly drawWidth: number;
  /** Scaled frame height in model pixels. */
  readonly drawHeight: number;
}

export function computeFrameTransform(
  sourceWidth: number,
  sourceHeight: number,
  modelSize = MODEL_INPUT_SIZE,
): FrameTransform {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`);
  }
  const scale = Math.min(modelSize / sourceWidth, modelSize / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return {
    sourceWidth,
    sourceHeight,
    scale,
    padX: (modelSize - drawWidth) / 2,
    padY: (modelSize - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Model-normalized `[y, x]` to `brush` space, i.e. unletterbox then mirror.
 * Returns `undefined` when the point lands in the letterbox padding, which the
 * shader rejects the same way.
 */
export function keypointToBrushSpace(
  normalizedY: number,
  normalizedX: number,
  transform: FrameTransform,
  modelSize = MODEL_INPUT_SIZE,
): Vec2 | undefined {
  const sourceX = (normalizedX * modelSize - transform.padX) / transform.scale;
  const sourceY = (normalizedY * modelSize - transform.padY) / transform.scale;
  const u = sourceX / transform.sourceWidth;
  const v = sourceY / transform.sourceHeight;
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return undefined;
  return { x: 1 - u, y: v };
}

/**
 * Inverse of {@link keypointToBrushSpace}: `brush` space to the model-normalized
 * `[y, x]` a keypoint would carry. Used to synthesize fixtures that are valid by
 * construction, and to round-trip test the transform.
 */
export function brushSpaceToKeypoint(
  point: Vec2,
  transform: FrameTransform,
  modelSize = MODEL_INPUT_SIZE,
): { readonly y: number; readonly x: number } {
  const sourceX = (1 - point.x) * transform.sourceWidth;
  const sourceY = point.y * transform.sourceHeight;
  return {
    y: (sourceY * transform.scale + transform.padY) / modelSize,
    x: (sourceX * transform.scale + transform.padX) / modelSize,
  };
}

/**
 * Reference implementation of the wrist state machine that `wrist.wgsl` runs on
 * the GPU. Nothing in the browser path calls it — the GPU is the only place
 * landmarks are ever touched — but it makes hysteresis, EMA, jump rejection and
 * reacquisition unit-testable, and the tests assert the two stay equivalent.
 */
export interface BrushSnapshot {
  prev: Vec2;
  current: Vec2;
  confidence: number;
  active: boolean;
  invalid: number;
  hasPrev: boolean;
  /** True when `paint.wgsl` should stamp a capsule for this result. */
  stroke: boolean;
  strokes: number;
}

export function createBrushSnapshot(): BrushSnapshot {
  return {
    prev: { x: 0, y: 0 },
    current: { x: 0, y: 0 },
    confidence: 0,
    active: false,
    invalid: 0,
    hasPrev: false,
    stroke: false,
    strokes: 0,
  };
}

export interface PoseSample {
  /** Model-normalized y of keypoint 10. */
  readonly y: number;
  /** Model-normalized x of keypoint 10. */
  readonly x: number;
  readonly score: number;
}

export function applyPoseSample(
  state: BrushSnapshot,
  sample: PoseSample,
  transform: FrameTransform,
  dtSeconds: number,
  options: { readonly reset?: boolean; readonly tuning?: BrushTuning } = {},
): BrushSnapshot {
  const tuning = options.tuning ?? BRUSH_TUNING;
  if (options.reset) state.hasPrev = false;
  state.stroke = false;

  const threshold = state.active ? tuning.stayConfidence : tuning.enterConfidence;
  const inRange =
    sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1 && sample.score >= threshold;
  const measured = inRange ? keypointToBrushSpace(sample.y, sample.x, transform) : undefined;

  if (!measured) {
    state.invalid += 1;
    state.confidence = Number.isFinite(sample.score) ? Math.max(0, sample.score) : 0;
    if (state.invalid >= tuning.invalidResetCount) {
      state.active = false;
      state.hasPrev = false;
    }
    return state;
  }

  state.invalid = 0;
  state.confidence = sample.score;

  const alpha = smoothingAlpha(dtSeconds, tuning.emaTauSeconds);
  const smoothed = state.active
    ? {
        x: state.current.x + (measured.x - state.current.x) * alpha,
        y: state.current.y + (measured.y - state.current.y) * alpha,
      }
    : measured;

  if (state.active) {
    const jump = Math.hypot(smoothed.x - state.current.x, smoothed.y - state.current.y);
    if (jump > maxJumpDistance(tuning)) {
      // Teleport: keep tracking but break the line so no connector is drawn.
      state.prev = measured;
      state.current = measured;
      state.hasPrev = false;
      return state;
    }
  }

  if (state.active && state.hasPrev) {
    state.prev = state.current;
    state.current = smoothed;
    state.stroke = true;
    state.strokes += 1;
    return state;
  }

  // Acquisition or reacquisition: seed continuity and deliberately draw nothing.
  state.prev = smoothed;
  state.current = smoothed;
  state.active = true;
  state.hasPrev = true;
  return state;
}

/**
 * 8x8 Bayer ordered-dither threshold index, 0..63. Identical construction to
 * `composite.wgsl`, which the unit tests pin against the literal matrix.
 *
 * `M(x, y) = sum_i 4^(k-1-i) * M2(bit_i(x), bit_i(y))`, LSB first, with
 * `M2(a, b) = ((a ^ b) << 1) | b`.
 */
export function bayer8(x: number, y: number): number {
  const bx = x & 7;
  const by = y & 7;
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const xb = (bx >> i) & 1;
    const yb = (by >> i) & 1;
    value = (value << 2) | (((xb ^ yb) << 1) | yb);
  }
  return value;
}

/**
 * Dither cell side in logical (CSS) pixels. Fixed, so the pattern never shimmers.
 *
 * 4 px is the point where the 8x8 Bayer super-cell spans a legible 32 px and the
 * dots read as a deliberate halftone screen rather than as sensor noise, while
 * still resolving a face. Smaller and the pattern dissolves into grain at docs
 * card size; larger and the figure stops being recognisable.
 */
export const DITHER_CELL_LOGICAL_PX = 4;

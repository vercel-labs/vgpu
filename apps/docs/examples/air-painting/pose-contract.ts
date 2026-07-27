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
 *
 * Both hands paint. There are two independent brushes — one per arm — each with
 * its own complete state machine (hysteresis, EMA, jump cap, invalid counter)
 * and no shared term anywhere, so one hand dropping out cannot disturb the line
 * the other is drawing. They accumulate into the same mask.
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

export const LEFT_ELBOW_INDEX = 7;
export const RIGHT_ELBOW_INDEX = 8;
export const LEFT_WRIST_INDEX = 9;
export const RIGHT_WRIST_INDEX = 10;

/**
 * One brush per arm. The slot index is also the index into the `brushes`
 * storage array every shader binds, so this table is the single place the
 * mapping from a GPU slot to a pair of COCO keypoints is written down.
 *
 * `name` is anatomical, as MoveNet labels it: `left` is the person's own left
 * hand, which appears on the *right* of the mirrored selfie view.
 */
export interface BrushLimb {
  readonly name: 'left' | 'right';
  /** Keypoint that gates the brush and anchors the extrapolation. */
  readonly wrist: number;
  /** Keypoint that gives the forearm its direction. */
  readonly elbow: number;
}

export const BRUSH_LIMBS: readonly BrushLimb[] = [
  { name: 'left', wrist: LEFT_WRIST_INDEX, elbow: LEFT_ELBOW_INDEX },
  { name: 'right', wrist: RIGHT_WRIST_INDEX, elbow: RIGHT_ELBOW_INDEX },
];

/** Two independent brushes, matching `@workgroup_size` in wrist.wgsl. */
export const BRUSH_COUNT = BRUSH_LIMBS.length;

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
 * `BrushState` storage layout, in f32 slots. Every shader binds an
 * `array<BrushState, BRUSH_COUNT>` named `brushes`, indexed by the slot in
 * {@link BRUSH_LIMBS}. WGSL sees this as a struct; the host only ever writes
 * zeros to it, so the two views only have to agree on the stride and the total.
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
 *   @size(28) strokes: f32,  // slot 9, padded so the array stride is 64
 * }
 * ```
 */
export const BRUSH_STATE_SLOTS = 10;
/**
 * Stride of one brush. The struct itself is 40 bytes; `@size(28)` on the last
 * member pads it to a 64-byte array stride, which keeps each brush on its own
 * cache-friendly boundary and keeps the host arithmetic trivial.
 */
export const BRUSH_STATE_BYTES = 64;
/** Whole `brushes` buffer: one 64-byte slot per limb. */
export const BRUSH_BUFFER_BYTES = BRUSH_STATE_BYTES * BRUSH_COUNT;

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
  // Sized for a palm, not a pen. 30 texels is ~6% of the mask width, which at a
  // normal arm's length reads as the width of a hand dragged across the glass;
  // the previous 10 drew a fingertip line, which is the wrong gesture entirely
  // for wiping something clear.
  radiusTexels: 30,
  // Proportional scaling of the old 1.1 feather would be 3.3. It is deliberately
  // a little wider: a pen wants a crisp edge, but a hand smears, and the wipe
  // boundary is the one place this effect can look either convincing or cheap.
  featherTexels: 4,
};

/**
 * The brush paints at the *hand*, not at the wrist.
 *
 * MoveNet has no hand keypoint, so the hand is extrapolated along the forearm:
 * `hand = wrist + factor * (wrist - elbow)`. Drawing at the wrist itself feels
 * wrong because the wrist is where the arm ends, not where the user is pointing.
 *
 * Which space to extrapolate in is a fair question, and the answer is that it
 * does not matter: `model -> source -> brush` is a chain of scales, a
 * translation and a mirror, i.e. entirely **affine**, and extrapolation is an
 * affine combination of two points (`(1 + k)·wrist - k·elbow`, weights summing
 * to 1). Any affine map therefore commutes with it. We do it in `brush` space
 * because that is where the clamp below is meaningful, and a unit test pins the
 * equivalence against the same extrapolation performed in model space.
 *
 * Two deliberate asymmetries:
 *
 * - Confidence gating for the brush stays on the **wrist** alone. The elbow only
 *   ever contributes direction, so a weak elbow must not silence a hand the
 *   model is sure about.
 * - The extrapolated point is **clamped** into the frame rather than rejected.
 *   Rejecting would drop the brush exactly when the user reaches for the edge,
 *   which is when they are most obviously trying to paint.
 */
export interface HandExtrapolation {
  /** Fraction of the forearm to extend past the wrist. */
  readonly factor: number;
  /** Below this elbow score the direction is untrustworthy; fall back to the raw wrist. */
  readonly elbowConfidence: number;
}

export const HAND_EXTRAPOLATION: HandExtrapolation = {
  // ~30% of the forearm lands the point in the middle of a closed hand for the
  // adult proportions MoveNet was trained on, without overshooting into thin air
  // when the arm is fully extended toward the camera.
  factor: 0.3,
  // Modest on purpose: the elbow only supplies a direction, and a roughly-placed
  // elbow still points the right way. This is far below the wrist's 0.45 enter.
  elbowConfidence: 0.2,
};

/**
 * `wrist + factor * (wrist - elbow)`, clamped to the unit square.
 *
 * Pass `undefined` for the elbow — or an elbow the caller has already judged
 * untrustworthy — to get the wrist straight back.
 */
export function extrapolateHand(
  wrist: Vec2,
  elbow: Vec2 | undefined,
  factor = HAND_EXTRAPOLATION.factor,
): Vec2 {
  if (!elbow) return wrist;
  return {
    x: Math.min(1, Math.max(0, wrist.x + (wrist.x - elbow.x) * factor)),
    y: Math.min(1, Math.max(0, wrist.y + (wrist.y - elbow.y) * factor)),
  };
}

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
 * Reference implementation of the per-brush state machine that `wrist.wgsl`
 * runs on the GPU, once per limb. Nothing in the browser path calls it — the
 * GPU is the only place landmarks are ever touched — but it makes hysteresis,
 * EMA, jump rejection, hand extrapolation and reacquisition unit-testable, and
 * the tests assert the two stay equivalent.
 *
 * One `BrushSnapshot` models one slot of the `brushes` array. Two brushes are
 * two snapshots; there is deliberately no shared state to get wrong.
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
  /** Model-normalized y of this limb's wrist keypoint. */
  readonly y: number;
  /** Model-normalized x of this limb's wrist keypoint. */
  readonly x: number;
  /** Wrist score. This alone gates the brush. */
  readonly score: number;
  /** Model-normalized y of this limb's elbow keypoint. */
  readonly elbowY?: number;
  /** Model-normalized x of this limb's elbow keypoint. */
  readonly elbowX?: number;
  /** Elbow score. Below {@link HAND_EXTRAPOLATION.elbowConfidence} the wrist is used raw. */
  readonly elbowScore?: number;
}

/** Reads one limb's wrist and elbow out of a flat `[1,1,17,3]` result. */
export function poseSampleFromKeypoints(keypoints: ArrayLike<number>, limb: BrushLimb): PoseSample {
  const wrist = limb.wrist * KEYPOINT_STRIDE;
  const elbow = limb.elbow * KEYPOINT_STRIDE;
  return {
    y: keypoints[wrist] ?? 0,
    x: keypoints[wrist + 1] ?? 0,
    score: keypoints[wrist + 2] ?? 0,
    elbowY: keypoints[elbow] ?? 0,
    elbowX: keypoints[elbow + 1] ?? 0,
    elbowScore: keypoints[elbow + 2] ?? 0,
  };
}

/**
 * The brush-space point a sample paints at: the wrist, extended along the
 * forearm when the elbow is trustworthy. `undefined` when the wrist itself is
 * off-frame or in the letterbox padding.
 *
 * Mirrors `hand_point()` in wrist.wgsl exactly.
 */
export function handFromSample(
  sample: PoseSample,
  transform: FrameTransform,
  extrapolation: HandExtrapolation = HAND_EXTRAPOLATION,
): Vec2 | undefined {
  const wrist = keypointToBrushSpace(sample.y, sample.x, transform);
  if (!wrist) return undefined;

  const { elbowY, elbowX, elbowScore } = sample;
  if (elbowY === undefined || elbowX === undefined) return wrist;
  if (!(elbowScore !== undefined && elbowScore >= extrapolation.elbowConfidence)) return wrist;
  if (!(elbowX >= 0 && elbowX <= 1 && elbowY >= 0 && elbowY <= 1)) return wrist;

  // An elbow in the padding gives a direction that is off the person entirely.
  const elbow = keypointToBrushSpace(elbowY, elbowX, transform);
  return extrapolateHand(wrist, elbow, extrapolation.factor);
}

export function applyPoseSample(
  state: BrushSnapshot,
  sample: PoseSample,
  transform: FrameTransform,
  dtSeconds: number,
  options: {
    readonly reset?: boolean;
    readonly tuning?: BrushTuning;
    readonly extrapolation?: HandExtrapolation;
  } = {},
): BrushSnapshot {
  const tuning = options.tuning ?? BRUSH_TUNING;
  if (options.reset) state.hasPrev = false;
  state.stroke = false;

  const threshold = state.active ? tuning.stayConfidence : tuning.enterConfidence;
  const inRange =
    sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1 && sample.score >= threshold;
  // The wrist decides whether this limb paints; the elbow only moves the point.
  const measured = inRange ? handFromSample(sample, transform, options.extrapolation) : undefined;

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
 * Frosted-glass tuning.
 *
 * The screen is fogged; your hands wipe it clear; it fogs back up. The mask is
 * the wipe: 1 is clean glass, 0 is fully frosted, and the compositor *lerps the
 * blur amount* by it rather than switching. That continuity is the whole reason
 * re-fogging reads as condensation creeping back instead of a light turning off.
 */
export interface FogTuning {
  /**
   * Time constant of the exponential re-fog, in seconds.
   *
   * The mask decays by `exp(-dt / tau)` each inference, so a wiped patch loses
   * half its clarity every `tau * ln 2` seconds — about 4.8 s here. Slow enough
   * that a drawn shape survives long enough to be admired, fast enough that
   * walking away leaves a fogged screen rather than a permanent painting.
   */
  readonly refogTauSeconds: number;
  /**
   * Coverage below which a texel snaps to exactly 0.
   *
   * Exponential decay never actually reaches zero, so without a floor every
   * texel ever wiped keeps a vanishing non-zero value forever: invisible, but it
   * defeats the compositor's early-out and leaves the glass subtly, permanently
   * unclean. One 8-bit step is comfortably below anything the eye can find.
   */
  readonly clearEpsilon: number;
  /**
   * Gaussian sigma of the frost, in *downsampled* blur texels.
   *
   * Combined with `blurDownsample` this is the effective blur in source pixels
   * (`sigma * downsample`). Kept in downsampled texels because that is the space
   * the 9-tap kernel actually walks.
   */
  readonly blurSigmaTexels: number;
  /**
   * Resolution divisor for the blur chain.
   *
   * Frost is heavy and low-frequency, so blurring at quarter resolution costs a
   * sixteenth of the samples and is visually indistinguishable — the one place
   * in this example where the cheap path is also the correct one.
   */
  readonly blurDownsample: number;
  /** Brightness the frost lifts toward, mimicking light scattered in condensation. */
  readonly frostLift: number;
  /** Amplitude of the static frost grain. Anchored to logical pixels, never animated. */
  readonly frostGrain: number;
  /**
   * Grain cell side in logical (CSS) pixels.
   *
   * Not 1. Per-pixel grain is wrong twice over: real condensation is a speckle
   * of droplets far coarser than a display pixel, and per-pixel white noise is
   * incompressible, which bloated the committed thumbnail to 1.5 MB. A 3 px cell
   * looks more like frost *and* lets PNG do its job.
   *
   * Measured in logical pixels and scaled by DPR at upload, so the speckle is a
   * fixed physical size and does not shimmer when the canvas resizes.
   */
  readonly grainCellLogicalPx: number;
}

export const FOG_TUNING: FogTuning = {
  refogTauSeconds: 7,
  clearEpsilon: 1 / 255,
  blurSigmaTexels: 2.2,
  blurDownsample: 4,
  // Enough lift to read as condensation, not so much that the frosted state
  // washes out to a flat grey card: the blacks still have to be black.
  frostLift: 0.1,
  frostGrain: 0.022,
  grainCellLogicalPx: 4,
};

/** Largest dt honoured by the re-fog, so a stalled tab does not fog in one step. */
export const MAX_FOG_DT = 0.25;

/**
 * Per-step multiplier for the exponential re-fog: `exp(-dt / tau)`.
 *
 * Computed on the CPU and uploaded, so `paint.wgsl` stays a multiply and this
 * single definition is what both the GPU and the tests use. Being multiplicative
 * it composes: applying it at 15 Hz and at 60 Hz converge to the same curve, so
 * the fog does not depend on the inference rate.
 */
export function fogDecay(dtSeconds: number, tauSeconds = FOG_TUNING.refogTauSeconds): number {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_FOG_DT);
  return Math.exp(-dt / Math.max(tauSeconds, 1e-4));
}

/**
 * Reference re-fog of one mask texel, mirroring `paint.wgsl`.
 *
 * `max` against the incoming wipe is what lets a hand paint *through* the decay:
 * a texel being actively wiped is pinned to the brush coverage no matter how
 * long it has been fogging.
 */
export function refogTexel(
  previous: number,
  wipeCoverage: number,
  dtSeconds: number,
  tuning: FogTuning = FOG_TUNING,
): number {
  const faded = previous * fogDecay(dtSeconds, tuning.refogTauSeconds);
  const next = Math.max(faded, Math.max(0, wipeCoverage));
  return next < tuning.clearEpsilon ? 0 : Math.min(1, next);
}

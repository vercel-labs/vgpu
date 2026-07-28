/**
 * Frozen brush contract for the air-painting example.
 *
 * Everything in this module is pure TypeScript with no GPU, DOM, or ORT
 * dependency, so it is shared unchanged by the browser runtime, the ORT-free
 * Node thumbnail, and the unit tests. It is also the interface the VISUAL owner
 * codes against: change a constant or a transform here and every consumer moves
 * together.
 *
 * This file deliberately knows **nothing about the model**. It used to be
 * `pose-contract.ts` and carried MoveNet's I/O shapes, COCO keypoint names and a
 * forearm extrapolation, which meant swapping the estimator touched the brush
 * rules too. The seam is now a single measurement per hand — see
 * {@link HandMeasurement} — and the model-specific half lives in
 * `hand-model-contract.ts`. That split is the entire reason the hand swap could
 * leave the state machine below untouched.
 *
 * Coordinate spaces, once, so nothing has to guess:
 *
 * 1. `source` — the camera frame in pixels, not mirrored. What the models see.
 * 2. `brush` — `source` normalized to [0,1]^2 and mirrored on x. This is the
 *    selfie view the user sees, so it is the space brush state, the paint mask
 *    and the compositor all use.
 *
 * The models are fed the un-mirrored frame on purpose, and exactly one mirror
 * exists in the whole system (`sourceToBrush` in hand-preprocess.ts, and the
 * matching line in hand.wgsl). Mirroring the input as well would cancel out and
 * quietly swap the user's hands back.
 *
 * Both hands paint. There are two independent brushes — one per tracked hand —
 * each with its own complete state machine (hysteresis, EMA, jump cap, invalid
 * counter) and no shared term anywhere, so one hand dropping out cannot disturb
 * the line the other is drawing. They accumulate into the same mask.
 */
import { MAX_HANDS } from './hand-model-contract';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * The one thing the estimator has to produce.
 *
 * A slot is a **persistent track identity**, never the model's current output
 * order and never an anatomical label. `x`/`y` are in `brush` space and
 * `confidence` is the landmark model's hand-presence scalar. Everything upstream
 * of this — anchors, NMS, rotated crops, the tracking loopback — exists only to
 * fill in these three numbers twice per frame.
 */
export interface HandMeasurement {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

/**
 * Two brushes, one per track slot, matching `@workgroup_size(2)` in hand.wgsl.
 *
 * The slot index is also the index into the `brushes` storage array every shader
 * binds. There is no table mapping slots to body parts any more: with a real
 * hand model, a slot is just "the first hand" and "the second hand".
 */
export const BRUSH_COUNT = MAX_HANDS;
export const BRUSH_SLOTS = [0, 1] as const;

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
 * `array<BrushState, BRUSH_COUNT>` named `brushes`, indexed by track slot. WGSL
 * sees this as a struct; the host only ever writes zeros to it, so the two views
 * only have to agree on the stride and the total.
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
/** Whole `brushes` buffer: one 64-byte slot per hand. */
export const BRUSH_BUFFER_BYTES = BRUSH_STATE_BYTES * BRUSH_COUNT;

/**
 * ROI storage layout: `vec2f center, f32 size, f32 rotation`, in source pixels.
 *
 * Two hand slots plus one fixed entry for the detector's full-frame letterbox,
 * so `hand-crop.wgsl` can build either model input from the same binding.
 */
export const ROI_SLOT_COUNT = 3;
export const ROI_STRIDE_FLOATS = 4;
export const ROI_BYTES = ROI_SLOT_COUNT * ROI_STRIDE_FLOATS * 4;
/** Index of the detector letterbox entry in the ROI buffer. */
export const ROI_DETECTOR_SLOT = 2;

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
  /** Consecutive invalid results that drop the active track. */
  readonly invalidResetCount: number;
  /** Capsule radius in mask texels. */
  readonly radiusTexels: number;
  /** Coverage ramp width in mask texels. */
  readonly featherTexels: number;
}

export const BRUSH_TUNING: BrushTuning = {
  // Unchanged from the MoveNet version. The numbers now gate hand *presence*
  // rather than a wrist keypoint score, and the gate evidence said to leave them
  // alone: presence is bimodal in practice — a hand that is there reads 0.95+
  // and one that is not reads under 0.05 — so the thresholds sit in a wide empty
  // band and retuning them would be fitting noise.
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

/** Diagonal of the unit brush square; the jump cap is a fraction of it. */
export const BRUSH_SPACE_DIAGONAL = Math.SQRT2;

/** Absolute jump cap in brush units, precomputed for the uniform. */
export function maxJumpDistance(tuning: BrushTuning = BRUSH_TUNING): number {
  return tuning.maxJumpFraction * BRUSH_SPACE_DIAGONAL;
}

/**
 * dt is clamped so a backgrounded tab cannot teleport the brush with one huge
 * step. Keep in sync with `hand.wgsl`, which is asserted by the unit tests.
 */
export const MAX_SMOOTHING_DT = 0.1;

/** Time-aware EMA weight. Identical expression to `hand.wgsl`. */
export function smoothingAlpha(dtSeconds: number, tauSeconds = BRUSH_TUNING.emaTauSeconds): number {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_SMOOTHING_DT);
  return 1 - Math.exp(-dt / Math.max(tauSeconds, 1e-4));
}

/**
 * Reference implementation of the per-slot state machine that `hand.wgsl` runs
 * on the GPU, once per hand. Nothing in the browser path calls it — the GPU is
 * the only place landmarks are ever touched — but it makes hysteresis, EMA, jump
 * rejection and reacquisition unit-testable, and the tests assert the two stay
 * equivalent.
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

/**
 * Applies one hand measurement to one brush slot.
 *
 * Behaviourally identical to the MoveNet-era `applyPoseSample`: the hysteresis,
 * the EMA, the jump cap and the invalid counter are the same code, and the same
 * tests still pin them. The only difference is what arrives — a palm centroid
 * already in `brush` space with a presence score, rather than a raw keypoint
 * that had to be unletterboxed, mirrored and extrapolated along a forearm first.
 *
 * Pass `undefined` for `measurement` when the slot produced no hand this result.
 */
export function applyHandMeasurement(
  state: BrushSnapshot,
  measurement: HandMeasurement | undefined,
  dtSeconds: number,
  options: { readonly reset?: boolean; readonly tuning?: BrushTuning } = {},
): BrushSnapshot {
  const tuning = options.tuning ?? BRUSH_TUNING;
  if (options.reset) state.hasPrev = false;
  state.stroke = false;

  const threshold = state.active ? tuning.stayConfidence : tuning.enterConfidence;
  const confidence = measurement?.confidence ?? 0;
  // Every comparison is false for NaN, which is the rejection we want.
  const inRange =
    measurement !== undefined &&
    measurement.x >= 0 &&
    measurement.x <= 1 &&
    measurement.y >= 0 &&
    measurement.y <= 1 &&
    confidence >= threshold;

  if (!inRange) {
    state.invalid += 1;
    state.confidence = Number.isFinite(confidence) ? Math.max(0, confidence) : 0;
    if (state.invalid >= tuning.invalidResetCount) {
      state.active = false;
      state.hasPrev = false;
    }
    return state;
  }

  const measured: Vec2 = { x: measurement.x, y: measurement.y };
  state.invalid = 0;
  state.confidence = confidence;

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
      // This is also what catches a slot swapped by a bad reacquisition.
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

// Consumes the 17 GPU-resident keypoints ONNX Runtime Web produced and updates
// the persistent brush state. Two invocations, one per hand, ~200 bytes read.
//
// This is the whole point of the example: the landmarks are never mapped, read
// back, or copied to the CPU. `keypoints` is a NON-OWNING wrap of ORT's output
// buffer, valid only for the dispatch the host submits before it flushes and
// disposes the wrapper. Never retain it.
//
// Layout of `keypoints` is MoveNet's `[1,1,17,3]` flattened: keypoint k occupies
// `[k*3] = y`, `[k*3+1] = x`, `[k*3+2] = score`, y/x normalized to the 192x192
// letterboxed input.
//
// BOTH HANDS PAINT. Slot 0 is the person's left arm (elbow 7, wrist 9), slot 1
// the right (elbow 8, wrist 10). Each slot owns a complete, independent state
// machine and touches only `brushes[slot]`, so there is no cross-talk: one hand
// leaving frame cannot break the other's line. Both stamp into the same mask.
//
// The brush paints at the HAND, not the wrist. MoveNet has no hand keypoint, so
// the hand is extrapolated along the forearm — see `hand_point()` below and the
// long note on `HAND_EXTRAPOLATION` in pose-contract.ts.
//
// Coordinate spaces are defined once in pose-contract.ts. Briefly: unletterbox
// model-normalized -> source-normalized, reject the padding, then mirror x to
// reach `brush` space, which is the selfie view the user sees.
//
// VISUAL owner: the transform, hysteresis, EMA and jump rules below are the
// frozen contract. Retune the constants through `BRUSH_TUNING` and
// `HAND_EXTRAPOLATION`, not by editing the state machine.

struct Uniforms {
  /// Letterbox padding in model pixels.
  pad: vec2f,
  /// Camera frame size in pixels.
  source: vec2f,
  /// Seconds since the previous consumed result.
  dt: f32,
  /// Source pixels -> model pixels.
  scale: f32,
  /// Confidence needed to start painting.
  enter_confidence: f32,
  /// Confidence needed to keep painting (hysteresis).
  stay_confidence: f32,
  /// EMA time constant in seconds.
  ema_tau: f32,
  /// Largest accepted step in brush units.
  max_jump: f32,
  /// 1.0 drops line continuity for this result (Clear was pressed).
  reset: f32,
  /// Fraction of the forearm to extend past the wrist to reach the hand.
  hand_extend: f32,
  /// Elbow score below which the forearm direction is not trusted.
  elbow_confidence: f32,
};

struct BrushState {
  /// Segment start in brush space.
  prev: vec2f,
  /// Segment end / current smoothed position in brush space.
  current: vec2f,
  /// Confidence of the last result.
  confidence: f32,
  /// 1.0 while a pose is being tracked. (`active` is a WGSL reserved keyword.)
  tracking: f32,
  /// Consecutive invalid results.
  invalid: f32,
  /// 1.0 when `prev` is a legitimate continuation of the stroke.
  has_prev: f32,
  /// 1.0 when paint.wgsl should stamp a capsule for this result.
  stroke: f32,
  /// Monotonic stamped-segment counter; diagnostic only.
  /// `@size(28)` pads the 40-byte struct to a 64-byte array stride.
  @size(28) strokes: f32,
};

/// One brush per hand; slot 0 is the person's left arm, slot 1 the right.
/// The array length is spelled as a literal on the binding below because
/// vgpu's auto-layout reflection requires one (VGPU-WGSL-REFLECT-ARRAY-LENGTH).
const BRUSH_COUNT: u32 = 2u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> keypoints: array<f32>;
@group(0) @binding(2) var<storage, read_write> brushes: array<BrushState, 2>;

const MODEL_SIZE: f32 = 192.0;
const LEFT_ELBOW: u32 = 7u;
const RIGHT_ELBOW: u32 = 8u;
const LEFT_WRIST: u32 = 9u;
const RIGHT_WRIST: u32 = 10u;
const INVALID_RESET: f32 = 2.0;
const MAX_DT: f32 = 0.1;

/// Model-normalized (x, y) -> source-normalized. Values outside [0,1] mean the
/// point landed in the black letterbox padding, i.e. not on the person.
fn unletterbox(raw: vec2f) -> vec2f {
  let model_px = raw * MODEL_SIZE;
  let source_px = (model_px - uniforms.pad) / max(uniforms.scale, 1e-6);
  return source_px / max(uniforms.source, vec2f(1.0));
}

fn in_unit(v: vec2f) -> bool {
  return all(v >= vec2f(0.0)) && all(v <= vec2f(1.0));
}

/// The point this limb actually paints at, in brush space.
///
/// `wrist_b` is the already-unletterboxed, already-mirrored wrist. The elbow is
/// consulted only for direction: if it is weak or off-frame the wrist is
/// returned untouched, and the extended point is clamped into the frame rather
/// than rejected so reaching for the edge never drops the brush.
fn hand_point(wrist_b: vec2f, elbow_k: u32) -> vec2f {
  let base = elbow_k * 3u;
  let raw = vec2f(keypoints[base + 1u], keypoints[base]);
  let score = keypoints[base + 2u];

  let elbow_norm = unletterbox(raw);
  // Every comparison is false for NaN, which is the rejection we want.
  let usable = score >= uniforms.elbow_confidence && in_unit(raw) && in_unit(elbow_norm);
  if (!usable) {
    return wrist_b;
  }

  let elbow_b = vec2f(1.0 - elbow_norm.x, elbow_norm.y);
  // Affine, so doing this in brush space is identical to doing it in model
  // space — including the mirror, which negates both x terms consistently.
  return clamp(wrist_b + (wrist_b - elbow_b) * uniforms.hand_extend, vec2f(0.0), vec2f(1.0));
}

/// One limb's complete state machine. Pure in, pure out: the caller stores the
/// result back into its own slot, so two limbs can never touch each other.
fn update_brush(state_in: BrushState, wrist_k: u32, elbow_k: u32) -> BrushState {
  var state = state_in;

  if (uniforms.reset > 0.5) {
    state.has_prev = 0.0;
  }
  // Nothing is painted unless this dispatch explicitly says so.
  state.stroke = 0.0;

  let base = wrist_k * 3u;
  let raw = vec2f(keypoints[base + 1u], keypoints[base]);
  let score = keypoints[base + 2u];

  // Hysteresis: harder to start than to continue. The wrist score alone gates
  // the brush; a weak elbow must not silence a hand the model is sure about.
  let threshold = select(uniforms.enter_confidence, uniforms.stay_confidence, state.tracking > 0.5);
  var valid = score >= threshold && in_unit(raw);

  let source_norm = unletterbox(raw);
  // A keypoint inside the black letterbox padding is not on the person.
  valid = valid && in_unit(source_norm);

  // The canvas shows a mirrored selfie view; the model saw the raw frame.
  let wrist_b = vec2f(1.0 - source_norm.x, source_norm.y);
  let measured = hand_point(wrist_b, elbow_k);

  if (!valid) {
    state.invalid = state.invalid + 1.0;
    state.confidence = max(score, 0.0);
    if (state.invalid >= INVALID_RESET) {
      // Pose lost. Dropping has_prev is what stops a long connector from being
      // drawn when the hand is reacquired somewhere else.
      state.tracking = 0.0;
      state.has_prev = 0.0;
    }
    return state;
  }

  state.invalid = 0.0;
  state.confidence = score;

  // Time-aware EMA: identical expression to `smoothingAlpha` in pose-contract.ts.
  let alpha = 1.0 - exp(-clamp(uniforms.dt, 0.0, MAX_DT) / max(uniforms.ema_tau, 1e-4));
  var smoothed = measured;
  if (state.tracking > 0.5) {
    smoothed = mix(state.current, measured, alpha);
  }

  if (state.tracking > 0.5 && distance(smoothed, state.current) > uniforms.max_jump) {
    // Implausible teleport: keep tracking the hand but break the line.
    state.prev = measured;
    state.current = measured;
    state.has_prev = 0.0;
    return state;
  }

  if (state.tracking > 0.5 && state.has_prev > 0.5) {
    state.prev = state.current;
    state.current = smoothed;
    state.stroke = 1.0;
    state.strokes = state.strokes + 1.0;
    return state;
  }

  // Acquisition or reacquisition: seed continuity, paint nothing this result.
  state.prev = smoothed;
  state.current = smoothed;
  state.tracking = 1.0;
  state.has_prev = 1.0;
  return state;
}

@compute @workgroup_size(2)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= BRUSH_COUNT) {
    return;
  }
  let is_right = slot == 1u;
  let wrist_k = select(LEFT_WRIST, RIGHT_WRIST, is_right);
  let elbow_k = select(LEFT_ELBOW, RIGHT_ELBOW, is_right);
  // Load, run, store exactly one slot. No shared memory, no barrier, no aliasing.
  brushes[slot] = update_brush(brushes[slot], wrist_k, elbow_k);
}

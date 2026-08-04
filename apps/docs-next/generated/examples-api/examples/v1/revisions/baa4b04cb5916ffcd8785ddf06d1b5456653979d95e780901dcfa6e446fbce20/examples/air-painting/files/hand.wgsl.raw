// Consumes the GPU-resident hand landmarks ONNX Runtime Web produced, updates
// the persistent brush state, and writes the ROI the next frame will crop.
//
// This is the whole point of the example: the 21 landmarks are never mapped,
// read back, or copied to the CPU. `lm0`/`lm1` are NON-OWNING wraps of ORT's
// output buffers, valid only for the dispatch the host submits before it flushes
// and disposes the wrappers. Never retain them.
//
// Layout of each landmark buffer is the graph's `[1,63]` flattened: landmark k
// occupies `[k*3] = x`, `[k*3+1] = y`, `[k*3+2] = z`, and — this is the part
// that is easy to get wrong — x and y are in **crop pixels** on [0,224], not
// normalized. A `[1,63]` float output landing in that range looks exactly like a
// normalized output scaled by something, so dividing by the wrong constant gives
// landmarks that are subtly wrong rather than obviously broken.
//
// BOTH HANDS PAINT. Each slot owns a complete, independent state machine and
// touches only `brushes[slot]` and `rois[slot]`, so there is no cross-talk: one
// hand leaving frame cannot break the other's line. Both stamp into the same
// mask.
//
// THE TRACKING LOOPBACK LIVES HERE. `next_roi()` turns this frame's landmarks
// into next frame's crop, which is what lets the palm detector be skipped while
// a hand stays healthy. Doing it on the host would mean reading the landmarks
// back every frame and would defeat the entire output path.
//
// The brush paints at the MCP KNUCKLE CENTROID, not a fingertip and not the
// wrist — see the note on MCP_LANDMARKS in hand-model-contract.ts.
//
// Confidence is the landmark model's own hand-presence scalar, passed in through
// the uniform because ORT returns that one float on the CPU. It is deliberately
// NOT the palm detector's score: real photographs score 0.58 at the detector and
// come back with presence 0.017, and painting a confident stroke from those
// would be drawing a hand that is not there.
//
// VISUAL owner: the hysteresis, EMA and jump rules below are the frozen
// contract, unchanged from the MoveNet version of this example. Retune through
// `BRUSH_TUNING`, not by editing the state machine.

struct Uniforms {
  /// Camera frame size in pixels.
  source: vec2f,
  /// Hand presence per slot, straight from the landmark model.
  presence: vec2f,
  /// 1.0 where the slot actually ran the landmark model this frame.
  ran: vec2f,
  /// Seconds since the previous consumed result.
  dt: f32,
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
  /// Landmark crop side in pixels; the divisor that makes landmarks normalized.
  crop_size: f32,
  /// How much to grow the landmark bounding box into the next ROI.
  loopback_scale: f32,
};

struct BrushState {
  /// Segment start in brush space.
  prev: vec2f,
  /// Segment end / current smoothed position in brush space.
  current: vec2f,
  /// Confidence of the last result.
  confidence: f32,
  /// 1.0 while a hand is being tracked. (`active` is a WGSL reserved keyword.)
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

struct Roi {
  /// Centre in source pixels.
  center: vec2f,
  /// Side length in source pixels.
  size: f32,
  /// Radians.
  rotation: f32,
};

/// Array lengths are spelled as literals on the bindings because vgpu's
/// auto-layout reflection requires one (VGPU-WGSL-REFLECT-ARRAY-LENGTH).
const BRUSH_COUNT: u32 = 2u;
const NUM_LANDMARKS: u32 = 21u;
const INVALID_RESET: f32 = 2.0;
const MAX_DT: f32 = 0.1;
const TARGET_ANGLE: f32 = 1.5707963267948966;
const TAU: f32 = 6.283185307179586;

/// Wrist and middle-finger MCP: the landmark model's own hand axis.
const AXIS_START: u32 = 0u;
const AXIS_END: u32 = 9u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> lm0: array<f32>;
@group(0) @binding(2) var<storage, read> lm1: array<f32>;
@group(0) @binding(3) var<storage, read_write> rois: array<Roi, 3>;
@group(0) @binding(4) var<storage, read_write> brushes: array<BrushState, 2>;

/// One landmark's xy in crop pixels.
///
/// WGSL cannot index across two bindings, so the slot picks its buffer with a
/// branch. Both invocations take the same side of it for all 21 reads, so it is
/// uniform within the invocation and costs nothing worth avoiding.
fn landmark_xy(slot: u32, index: u32) -> vec2f {
  let base = index * 3u;
  if (slot == 0u) {
    return vec2f(lm0[base], lm0[base + 1u]);
  }
  return vec2f(lm1[base], lm1[base + 1u]);
}

/// Crop pixels -> source pixels. Identical expression to `cropToSource` in
/// hand-pipeline.ts and to the sampling transform in hand-crop.wgsl.
fn crop_to_source(point_crop: vec2f, roi: Roi) -> vec2f {
  let c = cos(roi.rotation);
  let s = sin(roi.rotation);
  let d = (point_crop / max(uniforms.crop_size, 1.0) - vec2f(0.5)) * roi.size;
  return roi.center + vec2f(d.x * c - d.y * s, d.x * s + d.y * c);
}

fn normalise_angle(a: f32) -> f32 {
  return a - TAU * floor((a + 3.141592653589793) / TAU);
}

fn in_unit(v: vec2f) -> bool {
  return all(v >= vec2f(0.0)) && all(v <= vec2f(1.0));
}

/// Next frame's crop, from this frame's landmarks: the tracking loopback.
///
/// The hand's axis runs wrist -> middle-finger MCP and is rotated upright, which
/// is the pose the landmark model was trained on. The region is the bounding box
/// of all 21 points, squared off and grown so the fingers do not clip out when
/// the hand opens between frames.
fn next_roi(slot: u32) -> Roi {
  let start = crop_to_source(landmark_xy(slot, AXIS_START), rois[slot]);
  let end = crop_to_source(landmark_xy(slot, AXIS_END), rois[slot]);
  let rotation = normalise_angle(TARGET_ANGLE - atan2(-(end.y - start.y), end.x - start.x));

  var lo = vec2f(1e30);
  var hi = vec2f(-1e30);
  for (var i = 0u; i < NUM_LANDMARKS; i = i + 1u) {
    let p = crop_to_source(landmark_xy(slot, i), rois[slot]);
    lo = min(lo, p);
    hi = max(hi, p);
  }
  let extent = hi - lo;
  var roi: Roi;
  roi.center = (lo + hi) * 0.5;
  roi.size = max(extent.x, extent.y) * uniforms.loopback_scale;
  roi.rotation = rotation;
  return roi;
}

/// Mean of the four MCP knuckles, in source pixels. The part of the hand that
/// stays put while the fingers move, which is what a brush anchor needs.
fn mcp_centroid(slot: u32) -> vec2f {
  var sum = vec2f(0.0);
  sum = sum + crop_to_source(landmark_xy(slot, 5u), rois[slot]);
  sum = sum + crop_to_source(landmark_xy(slot, 9u), rois[slot]);
  sum = sum + crop_to_source(landmark_xy(slot, 13u), rois[slot]);
  sum = sum + crop_to_source(landmark_xy(slot, 17u), rois[slot]);
  return sum * 0.25;
}

/// One slot's complete state machine. Pure in, pure out: the caller stores the
/// result back into its own slot, so two hands can never touch each other.
///
/// Unchanged from the MoveNet version except for where `measured` and `score`
/// come from. That equivalence is asserted by the contract tests.
fn update_brush(state_in: BrushState, slot: u32, measured: vec2f, score: f32, valid_in: bool) -> BrushState {
  var state = state_in;

  if (uniforms.reset > 0.5) {
    state.has_prev = 0.0;
  }
  // Nothing is painted unless this dispatch explicitly says so.
  state.stroke = 0.0;

  // Hysteresis: harder to start than to continue.
  let threshold = select(uniforms.enter_confidence, uniforms.stay_confidence, state.tracking > 0.5);
  // Every comparison is false for NaN, which is the rejection we want.
  let valid = valid_in && score >= threshold && in_unit(measured);

  if (!valid) {
    state.invalid = state.invalid + 1.0;
    state.confidence = max(score, 0.0);
    if (state.invalid >= INVALID_RESET) {
      // Track lost. Dropping has_prev is what stops a long connector from being
      // drawn when the hand is reacquired somewhere else.
      state.tracking = 0.0;
      state.has_prev = 0.0;
    }
    return state;
  }

  state.invalid = 0.0;
  state.confidence = score;

  // Time-aware EMA: identical expression to `smoothingAlpha` in brush-contract.ts.
  let alpha = 1.0 - exp(-clamp(uniforms.dt, 0.0, MAX_DT) / max(uniforms.ema_tau, 1e-4));
  var smoothed = measured;
  if (state.tracking > 0.5) {
    smoothed = mix(state.current, measured, alpha);
  }

  if (state.tracking > 0.5 && distance(smoothed, state.current) > uniforms.max_jump) {
    // Implausible teleport, which is also how a swapped slot presents itself
    // after a reacquisition. Keep tracking the hand but break the line, so no
    // connector is ever drawn between two different hands.
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

  let ran = select(uniforms.ran.x, uniforms.ran.y, slot == 1u) > 0.5;
  let presence = select(uniforms.presence.x, uniforms.presence.y, slot == 1u);

  var measured = vec2f(0.0);
  var valid = false;
  if (ran) {
    let centroid_px = mcp_centroid(slot);
    let source_norm = centroid_px / max(uniforms.source, vec2f(1.0));
    // The canvas shows a mirrored selfie view; the model saw the raw frame.
    measured = vec2f(1.0 - source_norm.x, source_norm.y);
    valid = in_unit(source_norm);

    // Only feed the loopback while the hand is genuinely there. A diverged ROI
    // is worse than no ROI: it would keep the crop locked on empty space and the
    // track could never recover, so the host reacquires with the detector
    // instead.
    if (valid && presence >= uniforms.stay_confidence) {
      let candidate = next_roi(slot);
      let short_side = min(uniforms.source.x, uniforms.source.y);
      let fraction = candidate.size / max(short_side, 1.0);
      if (fraction > 0.02 && fraction < 2.5) {
        rois[slot] = candidate;
      }
    }
  }

  // Load, run, store exactly one slot. No shared memory, no barrier, no aliasing.
  brushes[slot] = update_brush(brushes[slot], slot, measured, presence, valid);
}

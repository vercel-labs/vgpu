// Consumes the 17 GPU-resident keypoints ONNX Runtime Web produced and updates
// the persistent brush state. One invocation, ~200 bytes read.
//
// This is the whole point of the example: the landmarks are never mapped, read
// back, or copied to the CPU. `keypoints` is a NON-OWNING wrap of ORT's output
// buffer, valid only for the dispatch the host submits before it flushes and
// disposes the wrapper. Never retain it.
//
// Layout of `keypoints` is MoveNet's `[1,1,17,3]` flattened: keypoint k occupies
// `[k*3] = y`, `[k*3+1] = x`, `[k*3+2] = score`, y/x normalized to the 192x192
// letterboxed input. v1 always uses index 10 (right wrist); picking the higher
// wrist would jump across the body.
//
// Coordinate spaces are defined once in pose-contract.ts. Briefly: unletterbox
// model-normalized -> source-normalized, reject the padding, then mirror x to
// reach `brush` space, which is the selfie view the user sees.
//
// VISUAL owner: the transform, hysteresis, EMA and jump rules below are the
// frozen contract. Retune the constants through `BRUSH_TUNING`, not by editing
// the state machine.

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
  strokes: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> keypoints: array<f32>;
@group(0) @binding(2) var<storage, read_write> brush: BrushState;

const MODEL_SIZE: f32 = 192.0;
const RIGHT_WRIST: u32 = 10u;
const INVALID_RESET: f32 = 2.0;
const MAX_DT: f32 = 0.1;

@compute @workgroup_size(1)
fn cs_main() {
  if (uniforms.reset > 0.5) {
    brush.has_prev = 0.0;
  }
  // Nothing is painted unless this dispatch explicitly says so.
  brush.stroke = 0.0;

  let base = RIGHT_WRIST * 3u;
  let raw_y = keypoints[base];
  let raw_x = keypoints[base + 1u];
  let score = keypoints[base + 2u];

  // Hysteresis: harder to start than to continue. Every comparison below is
  // false for NaN, which is exactly the rejection we want.
  let threshold = select(uniforms.enter_confidence, uniforms.stay_confidence, brush.tracking > 0.5);
  var valid = score >= threshold
    && raw_x >= 0.0 && raw_x <= 1.0
    && raw_y >= 0.0 && raw_y <= 1.0;

  // Unletterbox: model-normalized -> model px -> source px -> source-normalized.
  let model_px = vec2f(raw_x, raw_y) * MODEL_SIZE;
  let source_px = (model_px - uniforms.pad) / max(uniforms.scale, 1e-6);
  let source_norm = source_px / max(uniforms.source, vec2f(1.0));
  // A keypoint inside the black letterbox padding is not on the person.
  valid = valid && all(source_norm >= vec2f(0.0)) && all(source_norm <= vec2f(1.0));

  // The canvas shows a mirrored selfie view; the model saw the raw frame.
  let measured = vec2f(1.0 - source_norm.x, source_norm.y);

  if (!valid) {
    brush.invalid = brush.invalid + 1.0;
    brush.confidence = max(score, 0.0);
    if (brush.invalid >= INVALID_RESET) {
      // Pose lost. Dropping has_prev is what stops a long connector from being
      // drawn when the wrist is reacquired somewhere else.
      brush.tracking = 0.0;
      brush.has_prev = 0.0;
    }
    return;
  }

  brush.invalid = 0.0;
  brush.confidence = score;

  // Time-aware EMA: identical expression to `smoothingAlpha` in pose-contract.ts.
  let alpha = 1.0 - exp(-clamp(uniforms.dt, 0.0, MAX_DT) / max(uniforms.ema_tau, 1e-4));
  var smoothed = measured;
  if (brush.tracking > 0.5) {
    smoothed = mix(brush.current, measured, alpha);
  }

  if (brush.tracking > 0.5 && distance(smoothed, brush.current) > uniforms.max_jump) {
    // Implausible teleport: keep tracking the wrist but break the line.
    brush.prev = measured;
    brush.current = measured;
    brush.has_prev = 0.0;
    return;
  }

  if (brush.tracking > 0.5 && brush.has_prev > 0.5) {
    brush.prev = brush.current;
    brush.current = smoothed;
    brush.stroke = 1.0;
    brush.strokes = brush.strokes + 1.0;
    return;
  }

  // Acquisition or reacquisition: seed continuity, paint nothing this result.
  brush.prev = smoothed;
  brush.current = smoothed;
  brush.tracking = 1.0;
  brush.has_prev = 1.0;
}

// Reads the ten GPU-resident logits ONNX Runtime Web produced and draws the
// class probabilities.
//
// The softmax is computed here, so the 40 bytes of output are never copied or
// read back to the CPU. Class labels are static DOM text below the canvas.
//
// Everything is laid out in framebuffer pixels and antialiased with signed
// distance fields, so rounded corners, hairlines and glows keep their shape at
// any canvas aspect ratio. The chart uses the full width: class `i` owns the
// column `[i, i + 1) / 10`, which a plain ten-column DOM grid mirrors exactly,
// so every label sits under its own bar with no magic padding.
struct Uniforms {
  resolution: vec2f,
  /// 1.0 once a real inference result is bound, 0.0 for the idle state.
  has_result: f32,
  /// Side length of the model input in texels (28). Kept for the pipeline's
  /// uniform layout; the chart itself needs no input geometry.
  input_size: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> logits: array<f32>;
/// The normalized 28x28 input stays bound: `createVisualizer().render()` owns
/// this slot and the drawing surface next to the canvas already shows the ink,
/// so the chart deliberately does not draw the tensor a second time.
@group(0) @binding(2) var<storage, read> digit: array<f32>;

const CLASSES: u32 = 10u;

/// Chart band, as fractions of the height: 1.0 probability and the axis.
const CHART_TOP: f32 = 0.13;
const CHART_BASE: f32 = 0.855;
/// Every class stays visible even at a probability of ~0, as a small nub.
const MIN_BAR: f32 = 0.014;

const BG_TOP: vec3f = vec3f(0.038, 0.043, 0.055);
const BG_BOTTOM: vec3f = vec3f(0.024, 0.027, 0.036);
const AMBIENT: vec3f = vec3f(0.018, 0.028, 0.048);
const TRACK: vec3f = vec3f(0.072, 0.080, 0.099);
const TRACK_EDGE: vec3f = vec3f(0.125, 0.140, 0.170);
const RULE: vec3f = vec3f(0.055, 0.065, 0.082);
const AXIS: vec3f = vec3f(0.235, 0.270, 0.340);
/// Winning class: the docs' blue accent taken up to a bright cyan tip.
const WIN_LOW: vec3f = vec3f(0.055, 0.330, 0.720);
const WIN_HIGH: vec3f = vec3f(0.510, 0.850, 1.000);
const WIN_TIP: vec3f = vec3f(0.930, 0.980, 1.000);
const WIN_GLOW: vec3f = vec3f(0.120, 0.420, 0.780);
/// Runner-ups: the same hue, desaturated so the argmax reads instantly.
const REST_LOW: vec3f = vec3f(0.085, 0.135, 0.200);
const REST_HIGH: vec3f = vec3f(0.220, 0.360, 0.500);
const REST_TIP: vec3f = vec3f(0.400, 0.560, 0.720);

/// Numerically stable softmax over the ten logits.
fn probability(index: u32) -> f32 {
  var maximum = logits[0];
  for (var i = 1u; i < CLASSES; i = i + 1u) {
    maximum = max(maximum, logits[i]);
  }
  var total = 0.0;
  for (var i = 0u; i < CLASSES; i = i + 1u) {
    total = total + exp(logits[i] - maximum);
  }
  return exp(logits[index] - maximum) / total;
}

fn best_class() -> u32 {
  var best = 0u;
  for (var i = 1u; i < CLASSES; i = i + 1u) {
    if (logits[i] > logits[best]) { best = i; }
  }
  return best;
}

/// Signed distance to a rounded box, in the same units as `p`.
fn sd_round_box(p: vec2f, half_size: vec2f, radius: f32) -> f32 {
  let r = min(radius, min(half_size.x, half_size.y));
  let q = abs(p) - half_size + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

/// One-pixel analytic coverage for a distance expressed in pixels.
fn coverage(distance_px: f32) -> f32 {
  return clamp(0.5 - distance_px, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = max(uniforms.resolution, vec2f(1.0));
  let px = position.xy;
  let width = resolution.x;
  let height = resolution.y;
  let has_result = uniforms.has_result > 0.5;

  // Backdrop: a vertical wash plus a soft light from the top-left corner.
  var color = mix(BG_TOP, BG_BOTTOM, smoothstep(0.0, 1.0, px.y / height));
  color = color + AMBIENT * (1.0 - smoothstep(0.0, 1.15, length(px / height)));

  // ---------------------------------------------------------------- chart ---
  let column_w = width / f32(CLASSES);
  let top = CHART_TOP * height;
  let base = CHART_BASE * height;
  let span = base - top;
  let bar_half = min(column_w * 0.30, 0.075 * height);
  let bar_radius = bar_half * 0.5;
  // Full-bleed rules and axis, faded near the canvas edges so the hairlines
  // never end in a hard stub against the border.
  let edge_fade = smoothstep(0.0, 0.035 * width, min(px.x, width - px.x));
  let winner = best_class();

  // Halo and column wash behind the winning bar, drawn before the bars so it
  // reads as light spilling out of the argmax rather than a border.
  if (has_result) {
    let winner_x = (f32(winner) + 0.5) * column_w;
    let winner_h = max(probability(winner) * span, MIN_BAR * height);
    let to_winner = sd_round_box(
      px - vec2f(winner_x, base - winner_h * 0.5),
      vec2f(bar_half, winner_h * 0.5),
      bar_radius,
    );
    color = color + WIN_GLOW * 0.34 * exp(-max(to_winner, 0.0) / (0.05 * height));
    let band_x = 1.0 - smoothstep(column_w * 0.28, column_w * 0.9, abs(px.x - winner_x));
    let band_y = smoothstep(0.0, 0.05 * height, px.y - (top - 0.05 * height))
      * (1.0 - smoothstep(base - 0.015 * height, base, px.y));
    color = color + WIN_GLOW * 0.10 * band_x * band_y;
  }

  // Reference rules at 25 / 50 / 75 / 100 % of probability.
  for (var k = 1u; k <= 4u; k = k + 1u) {
    let y = base - span * f32(k) * 0.25;
    let weight = select(1.0, 1.8, k == 4u);
    color = color + RULE * weight * coverage(abs(px.y - y) - 0.5) * edge_fade;
  }

  // Bars: an unfilled track per class, the softmax fill on top of it.
  let index = u32(clamp(px.x / column_w, 0.0, f32(CLASSES) - 1.0));
  let bar_center_x = (f32(index) + 0.5) * column_w;
  let track = sd_round_box(px - vec2f(bar_center_x, (top + base) * 0.5), vec2f(bar_half, span * 0.5), bar_radius);
  // The track fades towards 1.0 probability so the chart never looks like a row
  // of solid slabs.
  let track_fade = 0.35 + 0.65 * smoothstep(top, base, px.y);
  color = mix(color, TRACK, coverage(track) * 0.92 * track_fade);
  color = mix(color, TRACK_EDGE, coverage(abs(track) - 0.6) * 0.4 * track_fade);

  if (has_result) {
    let is_winner = index == winner;
    let bar_h = max(probability(index) * span, MIN_BAR * height);
    let bar = sd_round_box(px - vec2f(bar_center_x, base - bar_h * 0.5), vec2f(bar_half, bar_h * 0.5), bar_radius);
    let along = clamp((base - px.y) / max(bar_h, 1.0), 0.0, 1.0);
    var fill = mix(
      select(REST_LOW, WIN_LOW, is_winner),
      select(REST_HIGH, WIN_HIGH, is_winner),
      smoothstep(0.0, 1.0, along) * 0.8 + along * 0.2,
    );
    // Glass sheen down the left flank of every bar.
    fill = fill + vec3f(0.05, 0.06, 0.07)
      * (1.0 - smoothstep(0.0, bar_half * 0.9, abs(px.x - (bar_center_x - bar_half * 0.45))));
    color = mix(color, fill, coverage(bar));
    // Bright tip so short bars still have a readable edge.
    let tip = coverage(bar) * coverage(abs(px.y - (base - bar_h)) - 1.4);
    color = mix(color, select(REST_TIP, WIN_TIP, is_winner), tip * select(0.45, 0.95, is_winner));
  }

  // Axis and one tick per class, pointing at the static DOM label below. The
  // winner's tick is brighter, which keeps the highlight in the shader.
  color = mix(color, AXIS, coverage(abs(px.y - base) - 0.9) * edge_fade);
  let tick = sd_round_box(px - vec2f(bar_center_x, base + 0.026 * height), vec2f(0.75, 0.015 * height), 0.75);
  let tick_weight = select(0.35, select(0.35, 1.0, index == winner), has_result);
  color = mix(color, AXIS + vec3f(0.10), coverage(tick) * tick_weight);

  return vec4f(color, 1.0);
}

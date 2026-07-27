// Reads the ten GPU-resident logits ONNX Runtime Web produced and draws the
// class probabilities.
//
// The softmax is computed here, so the 40 bytes of output are never copied or
// read back to the CPU. Class labels are static DOM text below the canvas.
//
// The look is deliberately flat and matches the docs UI: the Geist gray scale
// for the chrome, one blue accent for the data, no gradients and no glows.
// Everything is laid out in framebuffer pixels and antialiased with signed
// distance fields, so the hairlines stay one pixel wide at any canvas size.
// The chart uses the full width: class `i` owns the column `[i, i + 1) / 10`,
// which a plain ten-column DOM grid mirrors exactly, so every label sits under
// its own bar with no magic padding.
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

/// Docs palette, written straight into the non-sRGB target: the panel tone the
/// docs use for code and cards, then the same gray ramp for the chrome.
const BG: vec3f = vec3f(0.039, 0.039, 0.039);         // #0a0a0a  gray-1
const TRACK: vec3f = vec3f(0.098, 0.098, 0.098);      // #191919  gray-3
const RULE: vec3f = vec3f(0.133, 0.133, 0.133);       // #222222  gray-4
const AXIS: vec3f = vec3f(0.192, 0.192, 0.192);       // #313131  gray-6
const TICK: vec3f = vec3f(0.227, 0.227, 0.227);       // #3a3a3a  gray-7
/// The data uses a single hue: full accent for the argmax, the same blue
/// stepped down the scale for every other class.
const ACCENT: vec3f = vec3f(0.000, 0.439, 0.953);     // #0070f3  blue-9
const ACCENT_DIM: vec3f = vec3f(0.059, 0.204, 0.376); // #0f3460  blue-4

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

  var color = BG;

  // ---------------------------------------------------------------- chart ---
  let column_w = width / f32(CLASSES);
  let top = CHART_TOP * height;
  let base = CHART_BASE * height;
  let span = base - top;
  let bar_half = min(column_w * 0.30, 0.075 * height);
  // Just enough rounding to read as a drawn shape rather than a raw quad.
  let radius = max(1.5, 0.004 * height);
  let index = u32(clamp(px.x / column_w, 0.0, f32(CLASSES) - 1.0));
  let center_x = (f32(index) + 0.5) * column_w;
  let winner = best_class();
  // The rules and the axis stop a little short of the border, with a one-pixel
  // antialiased end instead of a fade.
  let inset = 0.02 * width;
  let rule_mask = clamp(min(px.x - inset, width - inset - px.x) + 0.5, 0.0, 1.0);

  // An empty track per class shows the 0..1 range the bar is measured against.
  let track = sd_round_box(
    px - vec2f(center_x, (top + base) * 0.5),
    vec2f(bar_half, span * 0.5),
    radius,
  );
  color = mix(color, TRACK, coverage(track));

  // Reference rules at 25 / 50 / 75 / 100 % of probability, one weight for all.
  for (var k = 1u; k <= 4u; k = k + 1u) {
    let y = base - span * f32(k) * 0.25;
    color = mix(color, RULE, coverage(abs(px.y - y) - 0.5) * rule_mask);
  }

  // The axis goes under the bars so their bases stay unbroken.
  color = mix(color, AXIS, coverage(abs(px.y - base) - 0.5) * rule_mask);

  if (has_result) {
    let bar_h = max(probability(index) * span, MIN_BAR * height);
    let bar = sd_round_box(
      px - vec2f(center_x, base - bar_h * 0.5),
      vec2f(bar_half, bar_h * 0.5),
      radius,
    );
    // Flat fill: the argmax is simply the one bar at full accent brightness.
    let fill = select(ACCENT_DIM, ACCENT, index == winner);
    color = mix(color, fill, coverage(bar));
  }

  // One tick per class, pointing at the static DOM label below. The winner's
  // tick picks up the accent, which keeps the highlight in the shader.
  let tick = sd_round_box(
    px - vec2f(center_x, base + 0.026 * height),
    vec2f(0.6, 0.015 * height),
    0.6,
  );
  var tick_color = TICK;
  if (has_result && index == winner) { tick_color = ACCENT; }
  color = mix(color, tick_color, coverage(tick));

  return vec4f(color, 1.0);
}

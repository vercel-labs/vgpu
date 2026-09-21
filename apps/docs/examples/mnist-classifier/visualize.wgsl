// Softmax and bars stay on the GPU, so logits never need a CPU readback.
struct Uniforms {
  resolution: vec2f,
  has_result: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> logits: array<f32>;

const CLASSES: u32 = 10u;

const CHART_TOP: f32 = 0.13;
const CHART_BASE: f32 = 0.855;
const MIN_BAR: f32 = 0.014;

const BG: vec3f = vec3f(0.039, 0.039, 0.039);         // #0a0a0a  gray-1
const TRACK: vec3f = vec3f(0.098, 0.098, 0.098);      // #191919  gray-3
const RULE: vec3f = vec3f(0.133, 0.133, 0.133);       // #222222  gray-4
const AXIS: vec3f = vec3f(0.192, 0.192, 0.192);       // #313131  gray-6
const TICK: vec3f = vec3f(0.227, 0.227, 0.227);       // #3a3a3a  gray-7
const ACCENT: vec3f = vec3f(0.000, 0.439, 0.953);     // #0070f3  blue-9
const ACCENT_DIM: vec3f = vec3f(0.059, 0.204, 0.376); // #0f3460  blue-4

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

fn sd_round_box(p: vec2f, half_size: vec2f, radius: f32) -> f32 {
  let r = min(radius, min(half_size.x, half_size.y));
  let q = abs(p) - half_size + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

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

  let column_w = width / f32(CLASSES);
  let top = CHART_TOP * height;
  let base = CHART_BASE * height;
  let span = base - top;
  let bar_half = min(column_w * 0.30, 0.075 * height);
  let radius = max(1.5, 0.004 * height);
  let index = u32(clamp(px.x / column_w, 0.0, f32(CLASSES) - 1.0));
  let center_x = (f32(index) + 0.5) * column_w;
  let winner = best_class();
  let inset = 0.02 * width;
  let rule_mask = clamp(min(px.x - inset, width - inset - px.x) + 0.5, 0.0, 1.0);

  let track = sd_round_box(
    px - vec2f(center_x, (top + base) * 0.5),
    vec2f(bar_half, span * 0.5),
    radius,
  );
  color = mix(color, TRACK, coverage(track));

  for (var k = 1u; k <= 4u; k = k + 1u) {
    let y = base - span * f32(k) * 0.25;
    color = mix(color, RULE, coverage(abs(px.y - y) - 0.5) * rule_mask);
  }

  color = mix(color, AXIS, coverage(abs(px.y - base) - 0.5) * rule_mask);

  if (has_result) {
    let bar_h = max(probability(index) * span, MIN_BAR * height);
    let bar = sd_round_box(
      px - vec2f(center_x, base - bar_h * 0.5),
      vec2f(bar_half, bar_h * 0.5),
      radius,
    );
    let fill = select(ACCENT_DIM, ACCENT, index == winner);
    color = mix(color, fill, coverage(bar));
  }

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

// Reads the ten GPU-resident logits ONNX Runtime Web produced and draws the
// class probabilities, plus a preview of the normalized 28x28 input.
//
// The softmax is computed here, so the 40 bytes of output are never copied or
// read back to the CPU. Class labels are static DOM text next to the canvas.
//
// Placeholder aesthetics: flat bars and a grayscale preview. The visual owner
// replaces the drawing code below; the bindings and `has_result` semantics are
// the contract.
struct Uniforms {
  resolution: vec2f,
  /// 1.0 once a real inference result is bound, 0.0 for the idle state.
  has_result: f32,
  /// Side length of the input preview in texels (28).
  input_size: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> logits: array<f32>;
@group(0) @binding(2) var<storage, read> digit: array<f32>;

const CLASSES: u32 = 10u;

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

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let background = vec3f(0.04, 0.05, 0.07);

  // Left third: the normalized input the model actually saw.
  if (uv.x < 0.32) {
    let preview = (uv - vec2f(0.03, 0.16)) / 0.68;
    if (preview.x >= 0.0 && preview.x < 0.4 && preview.y >= 0.0 && preview.y < 1.0) {
      let size = i32(uniforms.input_size);
      let cell = vec2i(clamp(vec2f(preview.x / 0.4, preview.y) * uniforms.input_size, vec2f(0.0), vec2f(uniforms.input_size - 1.0)));
      let ink = digit[cell.y * size + cell.x];
      return vec4f(mix(vec3f(0.02), vec3f(0.95, 0.97, 1.0), ink), 1.0);
    }
    return vec4f(background, 1.0);
  }

  // Right side: ten probability bars, one column per class.
  let barsStart = 0.36;
  let column = (uv.x - barsStart) / (1.0 - barsStart) * f32(CLASSES);
  if (column < 0.0 || column >= f32(CLASSES)) {
    return vec4f(background, 1.0);
  }
  let index = u32(column);
  let withinBar = fract(column);
  if (withinBar < 0.12 || withinBar > 0.88) {
    return vec4f(background, 1.0);
  }

  let baseline = 0.9;
  let height = select(0.0, probability(index) * 0.78, uniforms.has_result > 0.5);
  let filled = uv.y > baseline - height && uv.y < baseline;
  let track = uv.y > baseline - 0.78 && uv.y < baseline;
  if (filled) {
    let highlight = select(0.35, 1.0, index == best_class() && uniforms.has_result > 0.5);
    return vec4f(mix(vec3f(0.15, 0.35, 0.55), vec3f(0.45, 0.85, 1.0), highlight), 1.0);
  }
  if (track) {
    return vec4f(background + vec3f(0.03), 1.0);
  }
  return vec4f(background, 1.0);
}

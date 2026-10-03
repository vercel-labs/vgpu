struct Present {
  resolution: vec2f,
  // Tilt-shift strength (0 = off) and the focus line in UV space.
  tiltShift: f32,
  focus: f32,
  // Device pixels per CSS pixel: the blur radius is authored in CSS pixels.
  pixelRatio: f32,
}

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

const TAPS: array<vec2f, 12> = array<vec2f, 12>(
  vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457),
  vec2f(-0.203, 0.621), vec2f(0.962, -0.195), vec2f(0.473, -0.480),
  vec2f(0.519, 0.767), vec2f(0.185, -0.893), vec2f(0.507, 0.064),
  vec2f(0.896, 0.412), vec2f(-0.322, -0.933), vec2f(-0.792, -0.598),
);

// The scene target already holds tone-mapped sRGB color; this pass adds the miniature-lens
// blur away from the focus band and a soft vignette.
@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / present.resolution;
  let sharp = textureSampleLevel(sceneColor, linearSampler, uv, 0.0).rgb;
  let away = abs(uv.y - present.focus);
  let radius = present.tiltShift * smoothstep(0.16, 0.62, away) * 7.0 * present.pixelRatio;
  var color = sharp;
  if (radius > 0.25) {
    var sum = sharp;
    let texel = radius / present.resolution;
    for (var i = 0; i < 12; i++) {
      sum += textureSampleLevel(sceneColor, linearSampler, uv + TAPS[i] * texel, 0.0).rgb;
    }
    color = sum / 13.0;
  }
  let centered = (uv - 0.5) * vec2f(present.resolution.x / present.resolution.y, 1.0);
  let vignette = 1.0 - 0.28 * smoothstep(0.35, 1.05, length(centered));
  return vec4f(saturate(color * vignette), 1.0);
}

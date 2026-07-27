// One axis of the separable gaussian that frosts the camera feed.
//
// Run twice per displayed frame: horizontally from the full-resolution camera
// texture into a quarter-resolution target, then vertically from that target
// into a second one. Folding the downsample into the horizontal pass is free --
// that pass has to read the full-resolution texture anyway -- so only the first
// of the two ever touches the large texture.
//
// Quarter resolution is not a compromise here. Frost is heavy, low-frequency
// blur, and the detail the downsample discards is exactly the detail the blur
// is about to destroy. The bilinear sampler gives a 2x2 prefilter on the way
// down, and whatever aliasing survives is smeared by a sigma far wider than the
// texels that produced it.
//
// `uv` is normalized to *this pass's* destination while `texel_size` describes
// the *source*, which is what lets the same shader downsample and blur in one
// go instead of needing a separate resample pass.
//
// Kernel: 9 taps, weights evaluated from `sigma` at runtime rather than baked as
// a table, so FOG_TUNING.blurSigmaTexels stays a single tunable in one file. At
// the sigma this example uses, taps past +/-4 carry less weight than an 8-bit
// step and buy nothing.

struct Frost {
  /// 1 / size of the texture being *sampled*, so steps land on texel centres.
  texel_size: vec2f,
  /// (1, 0) horizontal or (0, 1) vertical. Separability is what makes this cheap.
  direction: vec2f,
  /// Gaussian sigma in texels of the sampled texture.
  sigma: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> frost: Frost;

/// Half-width of the kernel in taps; 9 total, symmetric about the centre.
const TAPS: i32 = 4;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let step = frost.texel_size * frost.direction;
  let sigma = max(frost.sigma, 1e-3);
  let denom = 2.0 * sigma * sigma;

  // Centre tap first, then symmetric pairs: one exp() per pair instead of two.
  var sum = textureSampleLevel(src, samp, uv, 0.0).rgb;
  var weight_sum = 1.0;
  for (var i = 1; i <= TAPS; i = i + 1) {
    let offset = f32(i);
    let w = exp(-(offset * offset) / denom);
    sum = sum + textureSampleLevel(src, samp, uv + step * offset, 0.0).rgb * w;
    sum = sum + textureSampleLevel(src, samp, uv - step * offset, 0.0).rgb * w;
    weight_sum = weight_sum + 2.0 * w;
  }

  return vec4f(sum / weight_sum, 1.0);
}

struct Uniforms {
  resolution: vec2f,
  edge_threshold: f32,
  edge_threshold_min: f32,
  subpix: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

fn load_scene(pixel: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(scene_tex));
  let clamped = clamp(pixel, vec2i(0), dims - vec2i(1));
  return textureLoad(scene_tex, clamped, 0).rgb;
}

fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.299, 0.587, 0.114));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);

  let rgb_m = load_scene(pixel);
  let rgb_n = load_scene(pixel + vec2i(0, -1));
  let rgb_s = load_scene(pixel + vec2i(0, 1));
  let rgb_w = load_scene(pixel + vec2i(-1, 0));
  let rgb_e = load_scene(pixel + vec2i(1, 0));

  let luma_m = luma(rgb_m);
  let luma_min = min(luma_m, min(min(luma(rgb_n), luma(rgb_s)), min(luma(rgb_w), luma(rgb_e))));
  let luma_max = max(luma_m, max(max(luma(rgb_n), luma(rgb_s)), max(luma(rgb_w), luma(rgb_e))));
  let contrast = luma_max - luma_min;
  let threshold = max(uniforms.edge_threshold_min, luma_max * uniforms.edge_threshold);

  // Compact FXAA-style resolve for the gallery: high-contrast pixels blend with their
  // cross neighbors while flat regions remain untouched. textureLoad avoids implicit
  // derivative validation issues in headless Dawn.
  let smoothed = (rgb_n + rgb_s + rgb_w + rgb_e + rgb_m * 2.0) / 6.0;
  let edge_factor = smoothstep(threshold, threshold * 2.0 + 0.0001, contrast) * clamp(uniforms.subpix, 0.0, 1.0);
  let color = mix(rgb_m, smoothed, edge_factor);

  return vec4f(color, 1.0);
}

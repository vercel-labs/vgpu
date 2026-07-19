// Additive fake god-rays: three outward triangle-edge quads sample fitted radiance once.
struct Config {
  screen: vec4f,
  radiance_fit: vec4f,
  params: vec4f,
  params2: vec4f,
};
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var radiance_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) near_sample_px: vec2f,
  @location(1) projected_sample_px: vec2f,
  @location(2) offset_scale: f32,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) near_sample_px: vec2f,
  @location(2) projected_sample_px: vec2f,
  @location(3) offset_scale: f32,
) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(position.x / cfg.screen.z, -position.z, 0.0, 1.0);
  out.near_sample_px = near_sample_px;
  out.projected_sample_px = projected_sample_px;
  out.offset_scale = offset_scale;
  return out;
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let enabled = cfg.params.x;
  let opacity = cfg.params.y;
  let lo = cfg.params.z;
  let hi = max(cfg.params.w, lo + 0.0001);
  let feather = max(cfg.params2.x, 0.001);
  let intensity = cfg.params2.y;
  let stretch = clamp(cfg.params2.z, 0.0, 1.0);
  let contrast_power = max(cfg.params2.w, 0.0001);
  if (enabled < 0.5 || opacity <= 0.0 || intensity <= 0.0) {
    return vec4f(0.0);
  }

  let ray_t = clamp(in.offset_scale, 0.0, 1.0);
  let sample_px = mix(in.near_sample_px, in.projected_sample_px, stretch * ray_t);
  let fitted_uv = (sample_px - cfg.radiance_fit.xy) / cfg.radiance_fit.zw;
  let inside_fit =
    fitted_uv.x >= 0.0 && fitted_uv.x <= 1.0 &&
    fitted_uv.y >= 0.0 && fitted_uv.y <= 1.0;
  let inside_mask = select(0.0, 1.0, inside_fit);

  let radiance = textureSample(
    radiance_tex,
    linear_samp,
    clamp(fitted_uv, vec2f(0.0), vec2f(1.0)),
  ).rgb;
  let contrast = pow(smoothstep(lo, hi, luminance(radiance)), contrast_power);
  let feather_width = 1.0 - exp(-feather);
  let end_fade = 1.0 - smoothstep(1.0 - feather_width, 1.0, ray_t);
  let distance_fade = pow(1.0 - ray_t * 0.45, 1.1);
  let theme_scale = mix(1.0, 0.08, cfg.screen.w);
  let shaped = radiance * contrast * end_fade * distance_fade;
  return vec4f(shaped * opacity * intensity * theme_scale * inside_mask, 0.0);
}

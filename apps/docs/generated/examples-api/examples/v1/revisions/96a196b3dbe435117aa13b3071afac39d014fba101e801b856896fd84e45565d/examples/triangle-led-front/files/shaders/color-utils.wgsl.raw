const OK_INV_B = mat3x3<f32>(0.4121656120, 0.2118591070, 0.0883097947, 0.5362752080, 0.6807189584, 0.2818474174, 0.0514575653, 0.1074065790, 0.6302613616);
const OK_FWD_B = mat3x3<f32>(4.0767245293, -1.2681437731, -0.0041119885, -3.3072168827, 2.6093323231, -0.7034763098, 0.2307590544, -0.3411344290, 1.7068625689);

export fn rgb_to_oklab(c: vec3f) -> vec3f {
  let lms = OK_INV_B * c;
  return sign(lms) * pow(abs(lms), vec3f(1.0 / 3.0));
}

export fn oklab_to_rgb(c: vec3f) -> vec3f {
  let lms = c * c * c;
  return OK_FWD_B * lms;
}

export fn col3v(v: vec3f) -> vec3f {
  return rgb_to_oklab(v);
}

export fn linear_to_srgb_pow(color: vec3f) -> vec3f {
  return pow(color, vec3f(1.0 / 2.2));
}


fn tonemap_lottes(x: vec3f) -> vec3f {
  let a = 1.6;
  let d = 0.977;
  let hdr_max = 8.0;
  let mid_in = 0.18;
  let mid_out = 0.267;
  let b =
    (-pow(mid_in, a) + pow(hdr_max, a) * mid_out)
    / ((pow(hdr_max, a * d) - pow(mid_in, a * d)) * mid_out);
  let c =
    (pow(hdr_max, a * d) * pow(mid_in, a) - pow(hdr_max, a) * pow(mid_in, a * d) * mid_out)
    / ((pow(hdr_max, a * d) - pow(mid_in, a * d)) * mid_out);
  return pow(x, vec3f(a)) / (pow(x, vec3f(a * d)) * b + c);
}

export fn tonemap(color: vec3f) -> vec3f {
  // Clamp to the finite rgba16float range, not just `max(_, 0)`: a bright COLORED LED in dark
  // mode (peak channel ~4x a same-luminance white LED) can overflow the half-float light texture
  // to +Inf. +Inf would reach the pow-based tonemaps and yield Inf/Inf = NaN, which clamps to 0
  // → a black ("burned") pixel. Anything past 65504 already saturates the tonemap to white, so
  // this is lossless for finite values and turns the burn back into the intended white.
  let c = clamp(color, vec3f(0.0), vec3f(65504.0));
  let mapped = tonemap_lottes(c);
  return linear_to_srgb_pow(clamp(mapped, vec3f(0.0), vec3f(1.0)));
}

export fn value_remap(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  return minOut + (value - minIn) * (maxOut - minOut) / (maxIn - minIn);
}

export fn value_remap_clamp(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  let remapped = value_remap(value, minIn, maxIn, minOut, maxOut);
  return clamp(remapped, min(minOut, maxOut), max(minOut, maxOut));
}

const OK_INV_B = mat3x3<f32>(0.4121656120, 0.2118591070, 0.0883097947, 0.5362752080, 0.6807189584, 0.2818474174, 0.0514575653, 0.1074065790, 0.6302613616);
const OK_FWD_B = mat3x3<f32>(4.0767245293, -1.2681437731, -0.0041119885, -3.3072168827, 2.6093323231, -0.7034763098, 0.2307590544, -0.3411344290, 1.7068625689);
const ACES_INPUT_MAT = mat3x3<f32>(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const ACES_OUTPUT_MAT = mat3x3<f32>(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);

export fn rgb_to_oklab(c: vec3f) -> vec3f {
  let lms = OK_INV_B * c;
  return sign(lms) * pow(abs(lms), vec3f(1.0 / 3.0));
}

export fn oklab_to_rgb(c: vec3f) -> vec3f {
  let lms = c * c * c;
  return OK_FWD_B * lms;
}

export fn col3(v: f32) -> vec3f {
  return rgb_to_oklab(vec3f(v));
}

export fn col3v(v: vec3f) -> vec3f {
  return rgb_to_oklab(v);
}

fn rrt_and_odt_fit(v: vec3f) -> vec3f {
  let a = v * (v + 0.0245786) - vec3f(0.000090537);
  let b = v * (0.983729 * v + 0.4329510) + vec3f(0.238081);
  return a / b;
}

export fn aces_fitted(color: vec3f) -> vec3f {
  var c = ACES_INPUT_MAT * color;
  c = rrt_and_odt_fit(c);
  c = ACES_OUTPUT_MAT * c;
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

export fn linear_to_srgb_pow(color: vec3f) -> vec3f {
  return pow(color, vec3f(1.0 / 2.2));
}

export fn value_remap(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  return minOut + (value - minIn) * (maxOut - minOut) / (maxIn - minIn);
}

export fn value_remap_clamp(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  let remapped = value_remap(value, minIn, maxIn, minOut, maxOut);
  return clamp(remapped, min(minOut, maxOut), max(minOut, maxOut));
}

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

// --- Tonemap operators -------------------------------------------------------
// Each maps LINEAR HDR → LINEAR [0,1], EXCEPT AgX (a full display transform) which
// returns sRGB-display directly. The tonemap() dispatcher owns the sRGB encode so
// every branch ends display-ready and there is no double gamma correction.
//
// Pick the operator by editing TONEMAP below (shader const → reload to apply). The
// operator shapes how the bright HDR glow rolls off to white:
//   ACES     — punchy/contrasty, desaturates highlights toward white (current look)
//   HABLE    — softer shoulder, smoother blend to white (Uncharted 2)
//   LOTTES   — filmic, bright mids, gentle shoulder (AMD)
//   AGX      — modern, very natural highlight desaturation (no over-saturation)
//   REINHARD — simplest baseline, darker mids (for comparison)
const TONEMAP_ACES: u32 = 0u;
const TONEMAP_HABLE: u32 = 1u;
const TONEMAP_LOTTES: u32 = 2u;
const TONEMAP_AGX: u32 = 3u;
const TONEMAP_REINHARD: u32 = 4u;
const TONEMAP: u32 = TONEMAP_LOTTES;

fn tonemap_reinhard(c: vec3f) -> vec3f {
  return c / (c + vec3f(1.0));
}

fn hable_partial(x: vec3f) -> vec3f {
  let a = 0.15;
  let b = 0.50;
  let c = 0.10;
  let d = 0.20;
  let e = 0.02;
  let f = 0.30;
  return ((x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f)) - e / f;
}

fn tonemap_hable(color: vec3f) -> vec3f {
  let exposure_bias = 2.0;
  let curr = hable_partial(color * exposure_bias);
  let white_scale = vec3f(1.0) / hable_partial(vec3f(11.2));
  return curr * white_scale;
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

// Minimal AgX (Benjamin Wrensch / iolite-engine). Returns sRGB-display-encoded.
fn agx_tonemap(color: vec3f) -> vec3f {
  let agx_mat = mat3x3<f32>(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104,
  );
  let agx_mat_inv = mat3x3<f32>(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
  );
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  var val = agx_mat * color;
  val = clamp(log2(max(val, vec3f(1e-10))), vec3f(min_ev), vec3f(max_ev));
  val = (val - min_ev) / (max_ev - min_ev);
  // 6th-order polynomial fit of the AgX contrast sigmoid.
  let x2 = val * val;
  let x4 = x2 * x2;
  var res =
    15.5 * x4 * x2 - 40.14 * x4 * val + 31.96 * x4
    - 6.868 * x2 * val + 0.4298 * x2 + 0.1191 * val - 0.00232;
  res = agx_mat_inv * res;
  return clamp(res, vec3f(0.0), vec3f(1.0));
}

// Dispatcher: LINEAR HDR in → sRGB-display out. Default ACES is byte-identical to the
// previous `linear_to_srgb_pow(aces_fitted(color))`.
export fn tonemap(color: vec3f) -> vec3f {
  // Clamp to the finite rgba16float range, not just `max(_, 0)`: a bright COLORED LED in dark
  // mode (peak channel ~4x a same-luminance white LED) can overflow the half-float light texture
  // to +Inf. +Inf would reach the pow-based tonemaps and yield Inf/Inf = NaN, which clamps to 0
  // → a black ("burned") pixel. Anything past 65504 already saturates the tonemap to white, so
  // this is lossless for finite values and turns the burn back into the intended white.
  let c = clamp(color, vec3f(0.0), vec3f(65504.0));
  if (TONEMAP == TONEMAP_AGX) {
    return agx_tonemap(c);
  }
  var mapped: vec3f;
  if (TONEMAP == TONEMAP_HABLE) {
    mapped = tonemap_hable(c);
  } else if (TONEMAP == TONEMAP_LOTTES) {
    mapped = tonemap_lottes(c);
  } else if (TONEMAP == TONEMAP_REINHARD) {
    mapped = tonemap_reinhard(c);
  } else {
    mapped = aces_fitted(c);
  }
  return linear_to_srgb_pow(clamp(mapped, vec3f(0.0), vec3f(1.0)));
}

export fn value_remap(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  return minOut + (value - minIn) * (maxOut - minOut) / (maxIn - minIn);
}

export fn value_remap_clamp(value: f32, minIn: f32, maxIn: f32, minOut: f32, maxOut: f32) -> f32 {
  let remapped = value_remap(value, minIn, maxIn, minOut, maxOut);
  return clamp(remapped, min(minOut, maxOut), max(minOut, maxOut));
}

export fn luminance(value: vec3f) -> f32 {
  return dot(value, vec3f(0.2126, 0.7152, 0.0722));
}

export fn applyExposure(value: vec3f, exposure: f32) -> vec3f {
  return value * exp2(exposure);
}

export fn srgbToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

export fn srgbToLinear3(value: vec3f) -> vec3f {
  return vec3f(srgbToLinear(value.r), srgbToLinear(value.g), srgbToLinear(value.b));
}

export fn srgbToLinear4(value: vec4f) -> vec4f {
  return vec4f(srgbToLinear3(value.rgb), value.a);
}

export fn linearToSrgb(value: f32) -> f32 {
  if (value <= 0.0031308) {
    return value * 12.92;
  }
  return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

export fn linearToSrgb3(value: vec3f) -> vec3f {
  return vec3f(linearToSrgb(value.r), linearToSrgb(value.g), linearToSrgb(value.b));
}

export fn linearToSrgb4(value: vec4f) -> vec4f {
  return vec4f(linearToSrgb3(value.rgb), value.a);
}

export fn tonemapAces(value: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((value * (a * value + b)) / (value * (c * value + d) + e), vec3f(0.0), vec3f(1.0));
}

export fn tonemapReinhard(value: vec3f) -> vec3f {
  return value / (1.0 + luminance(value));
}

export fn luminanceThreshold(value: vec3f, threshold: f32, softKnee: f32) -> vec3f {
  let knee = max(softKnee, 0.000001);
  let t = clamp((luminance(value) - threshold) / knee, 0.0, 1.0);
  let weight = t * t * (3.0 - 2.0 * t);
  return value * weight;
}

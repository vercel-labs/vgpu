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

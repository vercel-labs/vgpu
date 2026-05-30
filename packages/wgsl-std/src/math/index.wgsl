export fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

export fn clamp01(value: f32) -> f32 {
  return saturate(value);
}

export fn inverseLerp(from: f32, to: f32, value: f32) -> f32 {
  let denominator = to - from;
  if (denominator == 0.0) {
    return 0.0;
  }
  return (value - from) / denominator;
}

export fn remap(inMin: f32, inMax: f32, outMin: f32, outMax: f32, value: f32) -> f32 {
  let t = inverseLerp(inMin, inMax, value);
  return outMin + t * (outMax - outMin);
}

export fn safeNormalize2(value: vec2f, fallback: vec2f) -> vec2f {
  if (dot(value, value) <= 0.0) {
    return fallback;
  }
  return normalize(value);
}

export fn safeNormalize3(value: vec3f, fallback: vec3f) -> vec3f {
  if (dot(value, value) <= 0.0) {
    return fallback;
  }
  return normalize(value);
}

export fn safeNormalize4(value: vec4f, fallback: vec4f) -> vec4f {
  if (dot(value, value) <= 0.0) {
    return fallback;
  }
  return normalize(value);
}

export fn rotate2d(value: vec2f, radians: f32) -> vec2f {
  let c = cos(radians);
  let s = sin(radians);
  return vec2f(value.x * c - value.y * s, value.x * s + value.y * c);
}

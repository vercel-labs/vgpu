export fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

export fn clamp01(value: f32) -> f32 {
  return saturate(value);
}

export fn inverseLerp(rangeStart: f32, rangeEnd: f32, value: f32) -> f32 {
  let denominator = rangeEnd - rangeStart;
  if (denominator == 0.0) {
    return 0.0;
  }
  return (value - rangeStart) / denominator;
}

export fn remap(inMin: f32, inMax: f32, outMin: f32, outMax: f32, value: f32) -> f32 {
  let t = inverseLerp(inMin, inMax, value);
  return outMin + t * (outMax - outMin);
}

export fn safeNormalize2(value: vec2f, fallback: vec2f) -> vec2f {
  let lengthSquared = dot(value, value);
  if (lengthSquared <= 0.0) {
    return fallback;
  }
  return value * inverseSqrt(lengthSquared);
}

export fn safeNormalize3(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  if (lengthSquared <= 0.0) {
    return fallback;
  }
  return value * inverseSqrt(lengthSquared);
}

export fn safeNormalize4(value: vec4f, fallback: vec4f) -> vec4f {
  let lengthSquared = dot(value, value);
  if (lengthSquared <= 0.0) {
    return fallback;
  }
  return value * inverseSqrt(lengthSquared);
}

export fn rotate2d(value: vec2f, radians: f32) -> vec2f {
  let c = cos(radians);
  let s = sin(radians);
  return mat2x2f(c, s, -s, c) * value;
}

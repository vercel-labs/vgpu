export fn fullscreenTriangleClip(index: u32) -> vec4f {
  let x = f32(index >> 1u) * 4.0 - 1.0;
  let y = f32(min(index, 1u)) * 4.0 - 3.0;
  return vec4f(x, y, 0.0, 1.0);
}

export fn fullscreenTriangleUv(clipXy: vec2f) -> vec2f {
  return clipXy * vec2f(0.5, -0.5) + vec2f(0.5);
}

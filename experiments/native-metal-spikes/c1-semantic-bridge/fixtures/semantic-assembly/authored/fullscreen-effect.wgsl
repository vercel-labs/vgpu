struct EffectInput {
  @location(0) uv: vec2f,
}

@fragment
fn shade(input: EffectInput) -> @location(0) vec4f {
  return vec4f(input.uv, 0.25, 1.0);
}

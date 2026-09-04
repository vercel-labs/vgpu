struct FullscreenFragmentInput {
  @location(0) uv: vec2f,
  @builtin(front_facing) front_facing: bool,
}

@fragment
fn shade(input: FullscreenFragmentInput) -> @location(0) vec4f {
  return vec4f(input.uv, select(0.0, 1.0, input.front_facing), 1.0);
}

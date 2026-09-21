struct Params {
  viewProjection: mat4x4f,
}
@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> @builtin(position) vec4f {
  _ = normal;
  return params.viewProjection * vec4f(position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  let alpha = 0.72;
  return vec4f(vec3f(0.24, 0.86, 1.0) * alpha, alpha);
}

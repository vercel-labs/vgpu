struct Params {
  viewProjection: mat4x4f,
  model: mat4x4f,
  meshMin: vec3f,
  meshMax: vec3f,
}
@group(0) @binding(0) var<uniform> params: Params;

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
) -> @builtin(position) vec4f {
  let localPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  _ = packed_normal;
  return params.viewProjection * params.model * vec4f(localPosition, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  let alpha = 0.82;
  return vec4f(vec3f(0.0, 0.72, 1.0) * alpha, alpha);
}

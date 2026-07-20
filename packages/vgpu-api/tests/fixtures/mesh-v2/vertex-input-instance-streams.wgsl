// gpu.mesh v2 fixture: one vertex stream plus one instance stream.
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(
  @location(0) corner: vec2f,
  @location(1) i_pos: vec3f,
  @location(2) i_color: vec4f,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(i_pos.xy + corner, i_pos.z, 1.0);
  out.color = i_color;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return input.color;
}

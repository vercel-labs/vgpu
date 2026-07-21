// gpu.mesh v2 fixture: direct vertex parameters matched by attribute name.
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position + normal * 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.uv, 0.0, 1.0);
}

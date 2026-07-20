// gpu.mesh v2 fixture: mixed direct params, struct inputs, and builtins.
struct InstanceIn {
  @location(2) instance_offset: vec3f,
  @location(3) instance_tint: vec4f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) tint: vec4f,
};

@vertex fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  instance: InstanceIn,
) -> VertexOut {
  var out: VertexOut;
  let corner = f32(vertexIndex & 1u) * 0.0;
  out.position = vec4f(position + instance.instance_offset + vec3f(uv, corner) * 0.0, 1.0);
  out.tint = instance.instance_tint;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return input.tint;
}

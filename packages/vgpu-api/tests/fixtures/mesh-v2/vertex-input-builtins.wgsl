// gpu.mesh v2 fixture: @builtin parameters are ignored by name matching.
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
  @location(0) position: vec2f,
  @location(1) color: vec4f,
) -> VertexOut {
  var out: VertexOut;
  let jitter = f32((vertexIndex + instanceIndex) & 1u) * 0.0;
  out.position = vec4f(position + vec2f(jitter), 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return input.color;
}

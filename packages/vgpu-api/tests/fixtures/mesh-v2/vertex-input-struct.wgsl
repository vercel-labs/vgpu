// gpu.mesh v2 fixture: vertex input struct should flatten to @location fields.
struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
};

@vertex fn vs_main(input: VSIn) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(input.position, 1.0);
  out.normal = normalize(input.normal + vec3f(input.uv, 0.0) * 0.0);
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(abs(input.normal), 1.0);
}

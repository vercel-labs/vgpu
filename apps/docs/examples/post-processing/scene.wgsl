struct Uniforms {
  time: f32,
  resolution: vec2f,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs_main(
  @location(0) local_position: vec2f,
  @location(1) color: vec3f,
  @location(2) phase: f32,
) -> VertexOut {
  // Every shape is real triangle geometry. A tiny common rotation and per-object drift
  // keep the live example moving without softening the high-contrast silhouettes.
  let angle = 0.025 * sin(uniforms.time * 0.24);
  let c = cos(angle);
  let s = sin(angle);
  let drift = vec2f(
    sin(uniforms.time * 0.31 + phase * 4.7),
    cos(uniforms.time * 0.27 + phase * 3.9),
  ) * 0.012;
  let moved = local_position + drift;
  let rotated = vec2f(moved.x * c - moved.y * s, moved.x * s + moved.y * c);
  let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);

  var out: VertexOut;
  out.position = vec4f(rotated.x / aspect, rotated.y, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}

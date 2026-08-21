struct Uniforms {
  time: f32,
  logical_resolution: vec2f,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) accent: f32,
};

@vertex
fn vs_main(
  @location(0) local_position: vec2f,
  @location(1) accent: f32,
) -> VertexOut {
  let angle = 0.16 + uniforms.time * 0.12;
  let c = cos(angle);
  let s = sin(angle);
  let rotated = vec2f(
    local_position.x * c - local_position.y * s,
    local_position.x * s + local_position.y * c,
  );
  let logical = max(uniforms.logical_resolution, vec2f(1.0));
  let aspect = logical.x / logical.y;

  var out: VertexOut;
  out.position = vec4f(rotated.x / aspect, rotated.y, 0.0, 1.0);
  out.accent = accent;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let cool = vec3f(0.34, 0.72, 1.0);
  let warm = vec3f(1.0, 0.93, 0.72);
  return vec4f(mix(cool, warm, in.accent), 1.0);
}

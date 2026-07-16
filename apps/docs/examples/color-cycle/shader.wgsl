struct Uniforms {
  time: f32,
  resolution: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn palette(t: f32) -> vec3f {
  let a = vec3f(0.52, 0.50, 0.48);
  let b = vec3f(0.48, 0.46, 0.50);
  let c = vec3f(1.00, 1.00, 1.00);
  let d = vec3f(0.00, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * t + d));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = (position.xy * 2.0 - uniforms.resolution) / min(uniforms.resolution.x, uniforms.resolution.y);
  let rings = sin(length(p) * 8.0 - uniforms.time * 2.0) * 0.08;
  let color = palette(uv.x + uv.y * 0.35 + rings + uniforms.time * 0.12);
  return vec4f(color, 1.0);
}

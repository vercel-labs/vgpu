struct Uniforms {
  time: f32,
  resolution: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn ball(p: vec2f, c: vec2f, r: f32) -> f32 {
  return r * r / max(dot(p - c, p - c), 0.0008);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = (position.xy * 2.0 - uniforms.resolution) / min(uniforms.resolution.x, uniforms.resolution.y);
  let t = uniforms.time;
  var field = 0.0;
  field += ball(uv, vec2f(sin(t * 0.9) * 0.55, cos(t * 0.7) * 0.35), 0.36);
  field += ball(uv, vec2f(cos(t * 0.6) * 0.55, sin(t * 1.1) * 0.42), 0.32);
  field += ball(uv, vec2f(sin(t * 1.3 + 2.0) * 0.45, cos(t * 0.8 + 1.0) * 0.46), 0.28);
  field += ball(uv, vec2f(cos(t * 1.4 + 0.5) * 0.35, sin(t * 0.9 + 3.0) * 0.55), 0.22);
  let edge = smoothstep(0.94, 1.02, field) - smoothstep(1.22, 1.34, field);
  let fill = smoothstep(1.0, 2.6, field);
  let color = mix(vec3f(0.02, 0.02, 0.08), vec3f(0.05, 0.85, 1.0), fill) + vec3f(0.95, 0.25, 1.0) * edge;
  return vec4f(color, 1.0);
}

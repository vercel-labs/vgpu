struct Uniforms {
  time: f32,
  resolution: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let vignette = smoothstep(1.2, 0.2, distance(uv, vec2f(0.5)));
  return vec4f(uv.x, uv.y, 0.46 + 0.16 * vignette, 1.0);
}

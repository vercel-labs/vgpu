struct Uniforms {
  resolution: vec2f,
  bloomStrength: f32,
  caAmount: f32,
  bloomOn: f32,
  caOn: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var linear_samp: sampler;

fn sample_scene_linear(uv: vec2f) -> vec3f {
  return textureSampleLevel(scene_tex, linear_samp, uv, 0.0).rgb;
}

fn sample_bloom_linear(uv: vec2f) -> vec3f {
  return textureSampleLevel(bloom_tex, linear_samp, uv, 0.0).rgb;
}

fn sample_composite(uv: vec2f) -> vec3f {
  return sample_scene_linear(uv) + sample_bloom_linear(uv) * uniforms.bloomStrength * uniforms.bloomOn;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let centered = uv - vec2f(0.5);
  // Classic radial lens separation: zero at the optical center and strongest at corners.
  // R and B travel in opposite directions while green remains the reference channel.
  let radial_offset = centered * dot(centered, centered) * uniforms.caAmount * uniforms.caOn;
  var color = vec3f(
    sample_composite(clamp(uv + radial_offset, vec2f(0.001), vec2f(0.999))).r,
    sample_composite(uv).g,
    sample_composite(clamp(uv - radial_offset, vec2f(0.001), vec2f(0.999))).b,
  );

  let vignette = smoothstep(0.92, 0.30, distance(uv, vec2f(0.5)));
  color *= 0.76 + 0.28 * vignette;
  color = pow(max(color, vec3f(0.0)), vec3f(0.94));
  return vec4f(color, 1.0);
}

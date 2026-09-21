struct StagePreviewUniforms {
  gain: f32,
};
@group(0) @binding(0) var<uniform> u: StagePreviewUniforms;
@group(0) @binding(1) var u_input: texture_2d<f32>;

fn signedLog(v: f32) -> f32 {
  return 0.5 + 0.5 * sign(v) * log(1.0 + abs(v) * u.gain) / log(1.0 + u.gain);
}

@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(u_input));
  let uv = clamp(position.xy / dims, vec2f(0.0), vec2f(0.999999));
  let texel = vec2u(floor(uv * dims));
  let v = textureLoad(u_input, texel, 0);
  let rgb = vec3f(signedLog(v.x), signedLog(v.y), signedLog(v.z));
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}

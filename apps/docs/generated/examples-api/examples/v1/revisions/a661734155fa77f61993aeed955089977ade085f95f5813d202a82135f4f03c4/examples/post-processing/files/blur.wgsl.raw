struct Uniforms {
  resolution: vec2f,
  direction: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

fn sample_source_linear(pixel: vec2f) -> vec3f {
  let uv = (pixel + vec2f(0.5)) / vec2f(textureDimensions(source_tex));
  return textureSampleLevel(source_tex, linear_samp, uv, 0.0).rgb;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = position.xy - vec2f(0.5);
  let axis = uniforms.direction;
  // Five linear samples reproduce a nine-tap Gaussian by pairing adjacent weights.
  var color = sample_source_linear(pixel) * 0.22702703;
  color += sample_source_linear(pixel + axis * 1.38461538) * 0.31621621;
  color += sample_source_linear(pixel - axis * 1.38461538) * 0.31621621;
  color += sample_source_linear(pixel + axis * 3.23076923) * 0.07027027;
  color += sample_source_linear(pixel - axis * 3.23076923) * 0.07027027;
  return vec4f(color, 1.0);
}

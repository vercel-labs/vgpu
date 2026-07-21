struct Uniforms {
  resolution: vec2f,
  direction: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_tex: texture_2d<f32>;

fn load_source(pixel: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(source_tex));
  return textureLoad(source_tex, clamp(pixel, vec2i(0), dims - vec2i(1)), 0).rgb;
}

fn sample_source_linear(pixel: vec2f) -> vec3f {
  let base = vec2i(floor(pixel));
  let blend = fract(pixel);
  let top = mix(load_source(base), load_source(base + vec2i(1, 0)), blend.x);
  let bottom = mix(load_source(base + vec2i(0, 1)), load_source(base + vec2i(1, 1)), blend.x);
  return mix(top, bottom, blend.y);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = position.xy - vec2f(0.5);
  let axis = uniforms.direction;
  // Five bilinear samples reproduce a nine-tap Gaussian by pairing adjacent weights
  // at fractional offsets. Manual interpolation avoids the facade's conservative
  // unfilterable-float reflection while removing blocky halo bands.
  var color = sample_source_linear(pixel) * 0.22702703;
  color += sample_source_linear(pixel + axis * 1.38461538) * 0.31621621;
  color += sample_source_linear(pixel - axis * 1.38461538) * 0.31621621;
  color += sample_source_linear(pixel + axis * 3.23076923) * 0.07027027;
  color += sample_source_linear(pixel - axis * 3.23076923) * 0.07027027;
  return vec4f(color, 1.0);
}

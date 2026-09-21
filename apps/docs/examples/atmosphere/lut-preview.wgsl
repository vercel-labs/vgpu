struct Preview { gain: f32, channel: f32, pad: vec2f };

@group(0) @binding(0) var<uniform> preview: Preview;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

fn linearToSrgb(value: vec3f) -> vec3f {
  let lo = value * 12.92;
  let hi = 1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, value <= vec3f(0.0031308));
}

/** Debug view of a 2D LUT: rgb (channel 0) or alpha (channel 1) scaled by gain. */
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = textureSample(lut, linearSampler, uv);
  let value = select(texel.rgb, vec3f(texel.a), preview.channel > 0.5) * preview.gain;
  return vec4f(linearToSrgb(saturate(value)), 1.0);
}

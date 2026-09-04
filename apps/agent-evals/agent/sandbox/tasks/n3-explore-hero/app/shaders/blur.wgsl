// Separable 9-tap Gaussian, one direction per pass.
struct Blur {
  texelSize: vec2f,
  direction: vec2f,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let stride = blur.texelSize * blur.direction * 2.5;
  var result = textureSampleLevel(src, samp, uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 5; i++) {
    let offset = stride * f32(i);
    result += textureSampleLevel(src, samp, uv + offset, 0.0).rgb * weights[i];
    result += textureSampleLevel(src, samp, uv - offset, 0.0).rgb * weights[i];
  }
  return vec4f(result, 1.0);
}

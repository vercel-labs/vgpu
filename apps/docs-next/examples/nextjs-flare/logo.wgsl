struct Params { logoCenter: vec2f, logoScale: vec2f, uvInset: vec2f, edge: f32, _pad: f32 }
@group(0) @binding(0) var logoSampler: sampler;
@group(0) @binding(1) var logoTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let local = (uv - params.logoCenter) / params.logoScale + vec2f(0.5);
  let inside = all(local >= vec2f(0.0)) && all(local <= vec2f(1.0));
  let sampleUv = mix(params.uvInset, vec2f(1.0) - params.uvInset, clamp(local, vec2f(0.0), vec2f(1.0)));
  let texel = textureSample(logoTexture, logoSampler, sampleUv);
  let luma = dot(texel.rgb, vec3f(0.299, 0.587, 0.114));
  let bright = mix(0.4, 1.0, smoothstep(0.04, 0.8, luma));
  var mask = texel.a * bright * select(0.0, 1.0, inside);
  mask = (mask + pow(mask, 3.0) * 0.6) * params.edge;
  return vec4f(vec3f(mask), 1.0);
}

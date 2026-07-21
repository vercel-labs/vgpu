struct Uniforms { resolution: vec2f };
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;
@fragment fn fs_main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureSample(scene_tex, linear_samp, p.xy / uniforms.resolution);
}

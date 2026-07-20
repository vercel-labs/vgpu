struct Uniforms { resolution: vec2f };
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let pixel = clamp(vec2i(p.xy), vec2i(0), vec2i(uniforms.resolution) - 1);
  return textureLoad(scene_tex, pixel, 0);
}

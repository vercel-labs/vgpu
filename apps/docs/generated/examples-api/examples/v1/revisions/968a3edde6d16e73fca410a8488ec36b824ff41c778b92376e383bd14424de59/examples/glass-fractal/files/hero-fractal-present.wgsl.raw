@group(0) @binding(0) var sceneTexture: texture_2d<f32>;

@fragment fn fs_main(
  @builtin(position) position: vec4f,
) -> @location(0) vec4f {
  return textureLoad(sceneTexture, vec2i(position.xy), 0);
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let outputSize = textureDimensions(outputTexture);
  if (any(id.xy >= outputSize)) { return; }
  let sourceSize = vec2i(textureDimensions(sourceTexture));
  let origin = vec2i(id.xy * 2u);
  var color = vec4f(0.0);
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      color += textureLoad(sourceTexture, min(origin + vec2i(x, y), sourceSize - 1), 0);
    }
  }
  textureStore(outputTexture, id.xy, color * 0.25);
}

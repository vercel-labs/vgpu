// Copies the rasterized wall onto the output, so the glass has something to
// stand in front of and something to refract.
//
// The glass pass reads the same texture as a bound resource while drawing over
// this copy, which is why the wall is drawn into an offscreen target first
// instead of straight onto the canvas: a pass cannot sample the attachment it is
// writing to. Copied from `glass-fractal`, which splits its frame the same way.

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(sceneTexture, vec2i(position.xy), 0);
}

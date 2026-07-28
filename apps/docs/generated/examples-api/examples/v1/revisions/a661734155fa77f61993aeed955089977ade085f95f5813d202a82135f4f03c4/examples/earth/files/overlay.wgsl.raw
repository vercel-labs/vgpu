// Lays the planet over the sky already sitting in the HDR beauty buffer.
//
// The planet is drawn to an MSAA `rgba8unorm-srgb` target cleared to transparent
// black, so alpha carries geometric coverage — resolved edge samples on the limb
// plus the atmosphere shell's own transparency — and alpha blending has already
// premultiplied the colour. That makes this pass a plain blit with the
// `premultiplied` blend preset, and the sky pass keeps its contents thanks to
// `clear: false`.

@group(0) @binding(0) var planetTexture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(planetTexture, samp, uv, 0.0);
}

// Stretches a field into its resized twin, so a resize or a resolution change
// keeps the fluid instead of clearing it. Velocity is in texels per second,
// so it is rescaled with the grid.

struct Carry {
  scale: vec4f,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> carry: Carry;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(source, samp, uv, 0.0) * carry.scale;
}

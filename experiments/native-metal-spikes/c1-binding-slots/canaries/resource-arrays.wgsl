@group(0) @binding(0) var textures: binding_array<texture_2d<f32>, 3>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var fallback_texture: texture_2d<f32>;
@group(0) @binding(3) var fallback_sampler: sampler;

@compute @workgroup_size(1) fn main() {
  let first = textureSampleLevel(textures[0], source_sampler, vec2f(0.5), 0.0);
  let fallback = textureSampleLevel(fallback_texture, fallback_sampler, vec2f(0.5), 0.0);
  _ = first + fallback;
}

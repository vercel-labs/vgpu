struct Present {
  resolution: vec2f,
}

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

@fragment
fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureSample(scene_texture, linear_sampler, position.xy / present.resolution);
}

struct Uniforms {
  resolution: vec2f,
  direction: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

const OFFSETS = array<i32, 5>(0, 1, 2, 3, 4);
const WEIGHTS = array<f32, 5>(0.22702703, 0.19459459, 0.12162162, 0.05405405, 0.01621622);

fn load_source(pixel: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(source_tex));
  let clamped = clamp(pixel, vec2i(0), dims - vec2i(1));
  return textureLoad(source_tex, clamped, 0).rgb;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let axis = vec2i(round(uniforms.direction));
  var color = load_source(pixel) * WEIGHTS[0];

  // Bounded 9-tap separable Gaussian. textureLoad avoids implicit derivative validation
  // issues in the headless Docker/Dawn thumbnail environment.
  for (var i: u32 = 1u; i < 5u; i = i + 1u) {
    let offset = axis * OFFSETS[i];
    color += load_source(pixel + offset) * WEIGHTS[i];
    color += load_source(pixel - offset) * WEIGHTS[i];
  }

  return vec4f(color, 1.0);
}

// Turns the converged seed field into the distance field the sphere tracer samples.
// R holds the distance in scene pixels; the target is rgba16float because the tracer needs
// bilinear filtering, which 32-bit float targets do not offer without an optional feature.

@group(0) @binding(0) var seeds: texture_2d<f32>;

fn jfa_distance(seed: vec4f, position: vec2f, far: f32) -> f32 {
  return select(far, distance(seed.xy, position), seed.w >= 0.5);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(seeds));
  let pixel = clamp(floor(uv * size), vec2f(0.0), size - 1.0);
  let seed = textureLoad(seeds, vec2i(pixel), 0);
  let distance_px = jfa_distance(seed, pixel + 0.5, length(size) * 2.0);
  return vec4f(distance_px, 0.0, 0.0, 1.0);
}

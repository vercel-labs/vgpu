import { jfa_distance } from "./jfa-step.wgsl";

// Turns the converged seed field into the distance field the sphere tracer samples.
// R holds the distance in scene pixels; the target is rgba16float because the tracer needs
// bilinear filtering, which 32-bit float targets do not offer without an optional feature.

struct SdfFinalize {
  size: vec2f,
  /** Distance reported where the flood found nothing — larger than any on-screen ray. */
  far: f32,
  /** Encodes the distance for rgba8unorm debug targets; the live pipeline passes 1. */
  encode_scale: f32,
};

@group(0) @binding(0) var<uniform> sdf: SdfFinalize;
@group(0) @binding(1) var seeds: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = clamp(floor(uv * sdf.size), vec2f(0.0), sdf.size - 1.0);
  let seed = textureLoad(seeds, vec2i(pixel), 0);
  let distance_px = jfa_distance(seed, pixel + 0.5, sdf.far);
  return vec4f(distance_px * sdf.encode_scale, 0.0, 0.0, 1.0);
}

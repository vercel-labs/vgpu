import { rc_atlas_texel, rc_block_size, rc_ray_count } from "./rc-directions.wgsl";
import { distance_ramp, grid_albedo, linear_to_srgb, tonemap_aces } from "./scene-grid.wgsl";

// The only pass that leaves linear radiance. It resolves cascade 0 into irradiance, lights
// the grid with it, adds the emitters' own glow, and encodes once — tonemap and sRGB happen
// here and nowhere else, because merging in sRGB is what produces ringing and halos.
//
// `view` also makes the debug extraction visible: every option shows a real render target,
// not a re-derived approximation.

struct Present {
  /** Surface size in pixels. */
  size: vec2f,
  /** Cascade atlas size in texels. */
  atlas_size: vec2f,
  exposure: f32,
  /** 0 final, 1 emitters, 2 sdf, 3 cascade atlas. */
  view: f32,
  /** Distance, in pixels, at which the SDF debug ramp completes one band. */
  sdf_period: f32,
  /** Grid cell size in pixels. */
  grid_cell: f32,
  grid_line_width: f32,
  grid_base: f32,
  grid_line: f32,
  /** Light that never came from a probe: keeps unlit corners from being pure black. */
  ambient: f32,
};

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var cascade_tex: texture_2d<f32>;
@group(0) @binding(2) var emitter_tex: texture_2d<f32>;
@group(0) @binding(3) var sdf_tex: texture_2d<f32>;

/**
 * Irradiance at a pixel: the mean of cascade 0's four rays.
 *
 * Cascade 0 has one probe per pixel, so no spatial interpolation is needed here — the
 * bilinear work all happened during the merges above.
 */
fn resolve_cascade0(pixel: vec2f) -> vec3f {
  let block = rc_block_size(0.0);
  let rays = rc_ray_count(0.0);
  let probe = clamp(floor(pixel), vec2f(0.0), present.atlas_size / block - 1.0);
  var total = vec3f(0.0);
  for (var i = 0.0; i < rays; i = i + 1.0) {
    let coord = rc_atlas_texel(probe, i, block);
    total += textureLoad(cascade_tex, vec2i(coord), 0).rgb;
  }
  return total / rays;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = uv * present.size;
  let texel = vec2i(clamp(floor(pixel), vec2f(0.0), present.size - 1.0));
  let view = i32(present.view + 0.5);

  if (view == 1) {
    let emitter = textureLoad(emitter_tex, texel, 0);
    return vec4f(linear_to_srgb(tonemap_aces(emitter.rgb * present.exposure)), 1.0);
  }
  if (view == 2) {
    let distance_px = textureLoad(sdf_tex, texel, 0).r;
    return vec4f(linear_to_srgb(distance_ramp(distance_px, present.sdf_period)), 1.0);
  }
  if (view == 3) {
    // The raw atlas of whichever cascade the chain stopped at, stretched over the canvas:
    // probe blocks and their direction slots show up as the checker inside each block.
    let coord = vec2i(clamp(uv * present.atlas_size, vec2f(0.0), present.atlas_size - 1.0));
    let radiance = textureLoad(cascade_tex, coord, 0);
    return vec4f(linear_to_srgb(tonemap_aces(radiance.rgb * present.exposure)), 1.0);
  }

  let irradiance = resolve_cascade0(pixel);
  let albedo = grid_albedo(pixel, present.grid_cell, present.grid_line_width, present.grid_base, present.grid_line);
  let emitter = textureLoad(emitter_tex, texel, 0);
  // Emitters are opaque: they show their own radiance instead of the light landing on them.
  let lit = mix(albedo * (irradiance + present.ambient), emitter.rgb, clamp(emitter.a, 0.0, 1.0));
  return vec4f(linear_to_srgb(tonemap_aces(lit * present.exposure)), 1.0);
}

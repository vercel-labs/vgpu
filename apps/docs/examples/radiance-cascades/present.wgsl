import { rc_atlas_texel, rc_block_size, rc_ray_count } from "./rc-directions.wgsl";

// The only pass that leaves linear radiance. It resolves cascade 0 into irradiance, lights
// the grid with it, adds the emitters' own glow, and encodes once — tonemap and sRGB happen
// here and nowhere else, because merging in sRGB is what produces ringing and halos.
//
// `view` also makes the debug extraction visible: every option shows a real render target,
// not a re-derived approximation.

fn grid_albedo(
  pixel: vec2f,
  cell: f32,
  line_width: f32,
  base: f32,
  line: f32,
) -> vec3f {
  let to_line = abs(fract(pixel / cell - 0.5) - 0.5) * cell;
  let d = min(to_line.x, to_line.y);
  let strength = 1.0 - smoothstep(line_width - 0.75, line_width + 0.75, d);
  return vec3f(mix(base, line, strength));
}

fn tonemap_aces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + b)) / (color * (c * color + d) + e),
    vec3f(0.0),
    vec3f(1.0),
  );
}

fn linear_to_srgb(color: vec3f) -> vec3f {
  let low = color * 12.92;
  let high =
    1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, color <= vec3f(0.0031308));
}

fn distance_ramp(distance: f32, period: f32) -> vec3f {
  let near = exp(-distance / period);
  let bands = 0.5 + 0.5 * cos(6.283185307179586 * distance / period);
  return vec3f(near, near * 0.55 + 0.12 * bands, 0.35 * bands);
}

struct Present {
  /** x: 0 final, 1 emitters, 2 SDF, 3 cascade atlas. */
  view: vec4f,
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
  let atlas_size = vec2f(textureDimensions(cascade_tex));
  let probe = clamp(floor(pixel), vec2f(0.0), atlas_size / block - 1.0);
  var total = vec3f(0.0);
  for (var i = 0.0; i < rays; i = i + 1.0) {
    let coord = rc_atlas_texel(probe, i, block);
    total += textureLoad(cascade_tex, vec2i(coord), 0).rgb;
  }
  return total / rays;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(emitter_tex));
  let atlas_size = vec2f(textureDimensions(cascade_tex));
  let pixel = uv * size;
  let texel = vec2i(clamp(floor(pixel), vec2f(0.0), size - 1.0));
  let view = i32(present.view.x + 0.5);

  if (view == 1) {
    let emitter = textureLoad(emitter_tex, texel, 0);
    return vec4f(linear_to_srgb(tonemap_aces(emitter.rgb * 0.85)), 1.0);
  }
  if (view == 2) {
    let distance_px = textureLoad(sdf_tex, texel, 0).r;
    return vec4f(linear_to_srgb(distance_ramp(distance_px, 64.0)), 1.0);
  }
  if (view == 3) {
    // The raw atlas of whichever cascade the chain stopped at, stretched over the canvas:
    // probe blocks and their direction slots show up as the checker inside each block.
    let coord = vec2i(
      clamp(uv * atlas_size, vec2f(0.0), atlas_size - 1.0),
    );
    let radiance = textureLoad(cascade_tex, coord, 0);
    return vec4f(linear_to_srgb(tonemap_aces(radiance.rgb * 0.85)), 1.0);
  }

  let irradiance = resolve_cascade0(pixel);
  let albedo = grid_albedo(pixel, 48.0, 1.0, 0.38, 0.21);
  let emitter = textureLoad(emitter_tex, texel, 0);
  // Emitters are opaque: they show their own radiance instead of the light landing on them.
  let lit = mix(
    albedo * (irradiance + 0.01),
    emitter.rgb,
    clamp(emitter.a, 0.0, 1.0),
  );
  return vec4f(linear_to_srgb(tonemap_aces(lit * 0.85)), 1.0);
}

import { rc_atlas_texel, rc_block_size, rc_ray_count } from "./rc-directions.wgsl";
import { distance_ramp, linear_to_srgb, tonemap_aces } from "./scene-grid.wgsl";

struct Present {
  scene_size: vec2f,
  atlas_size: vec2f,
  exposure: f32,
  view: f32,
  sdf_period: f32,
  albedo: f32,
  ambient: f32,
  direction_base: f32,
};

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var cascade_tex: texture_2d<f32>;
@group(0) @binding(2) var emitter_tex: texture_2d<f32>;
@group(0) @binding(3) var sdf_tex: texture_2d<f32>;
@group(0) @binding(4) var jfa_tex: texture_2d<f32>;
@group(0) @binding(5) var emitter_samp: sampler;

fn resolve_probe(probe: vec2f) -> vec3f {
  let block = rc_block_size(0.0, present.direction_base);
  let rays = rc_ray_count(0.0, present.direction_base);
  let clamped_probe = clamp(probe, vec2f(0.0), present.atlas_size / block - 1.0);
  var total = vec3f(0.0);
  for (var i = 0.0; i < rays; i = i + 1.0) {
    total += textureLoad(cascade_tex, vec2i(rc_atlas_texel(clamped_probe, i, block)), 0).rgb;
  }
  return total / rays;
}

// The cascade field is intentionally capped below large display sizes. Resolve the four
// neighboring probes instead of magnifying a nearest-probe image, which keeps the light
// field continuous while preserving the exact radiance stored in the atlas.
fn resolve_cascade0(pixel: vec2f) -> vec3f {
  let position = pixel - 0.5;
  let base = floor(position);
  let blend = fract(position);
  let top = mix(resolve_probe(base), resolve_probe(base + vec2f(1.0, 0.0)), blend.x);
  let bottom = mix(resolve_probe(base + vec2f(0.0, 1.0)), resolve_probe(base + vec2f(1.0)), blend.x);
  return mix(top, bottom, blend.y);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = uv * present.scene_size;
  let texel = vec2i(clamp(floor(pixel), vec2f(0.0), present.scene_size - 1.0));
  let half_texel = 0.5 / present.scene_size;
  let scene_uv = clamp(uv, half_texel, vec2f(1.0) - half_texel);
  let view = i32(present.view + 0.5);

  if (view == 1) {
    let emitter = textureSampleLevel(emitter_tex, emitter_samp, scene_uv, 0.0);
    return vec4f(linear_to_srgb(tonemap_aces(emitter.rgb * present.exposure)), 1.0);
  }
  if (view == 2) {
    let distance_px = textureLoad(sdf_tex, texel, 0).r;
    return vec4f(linear_to_srgb(distance_ramp(distance_px, present.sdf_period)), 1.0);
  }
  if (view == 3) {
    let coord = vec2i(clamp(uv * present.atlas_size, vec2f(0.0), present.atlas_size - 1.0));
    let radiance = textureLoad(cascade_tex, coord, 0);
    return vec4f(linear_to_srgb(tonemap_aces(radiance.rgb * present.exposure)), 1.0);
  }
  if (view == 4) {
    let seed = textureLoad(jfa_tex, texel, 0);
    if (seed.a < 0.5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    let encoded = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + seed.x * 0.055 + seed.y * 0.089);
    return vec4f(encoded, 1.0);
  }

  let irradiance = resolve_cascade0(pixel);
  let emitter = textureSampleLevel(emitter_tex, emitter_samp, scene_uv, 0.0);
  let vignette = 1.0 - 0.42 * smoothstep(0.16, 0.72, distance(uv, vec2f(0.5)));
  let surface = vec3f(present.albedo * vignette);
  let lit = mix(surface * (irradiance + present.ambient), emitter.rgb, clamp(emitter.a, 0.0, 1.0));
  return vec4f(linear_to_srgb(tonemap_aces(lit * present.exposure)), 1.0);
}

import { rc_atlas_texel, rc_block_size, rc_ray_count } from "./rc-directions.wgsl";

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
  /** x: exposure, y: view, z: SDF period, w: direction block side. */
  display: vec4f,
  /** x: albedo, y: ambient. */
  lighting: vec4f,
};

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var cascade_tex: texture_2d<f32>;
@group(0) @binding(2) var emitter_tex: texture_2d<f32>;
@group(0) @binding(3) var sdf_tex: texture_2d<f32>;
@group(0) @binding(4) var jfa_tex: texture_2d<f32>;
@group(0) @binding(5) var emitter_samp: sampler;

fn resolve_probe(probe: vec2f) -> vec3f {
  let block = rc_block_size(0.0, present.display.w);
  let rays = rc_ray_count(0.0, present.display.w);
  let atlas_size = vec2f(textureDimensions(cascade_tex));
  let clamped_probe = clamp(probe, vec2f(0.0), atlas_size / block - 1.0);
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
  let scene_size = vec2f(textureDimensions(emitter_tex));
  let atlas_size = vec2f(textureDimensions(cascade_tex));
  let pixel = uv * scene_size;
  let texel = vec2i(clamp(floor(pixel), vec2f(0.0), scene_size - 1.0));
  let half_texel = 0.5 / scene_size;
  let scene_uv = clamp(uv, half_texel, vec2f(1.0) - half_texel);
  let view = i32(present.display.y + 0.5);

  if (view == 1) {
    let emitter = textureSampleLevel(emitter_tex, emitter_samp, scene_uv, 0.0);
    return vec4f(linear_to_srgb(tonemap_aces(emitter.rgb * present.display.x)), 1.0);
  }
  if (view == 2) {
    let distance_px = textureLoad(sdf_tex, texel, 0).r;
    return vec4f(linear_to_srgb(distance_ramp(distance_px, present.display.z)), 1.0);
  }
  if (view == 3) {
    let coord = vec2i(clamp(uv * atlas_size, vec2f(0.0), atlas_size - 1.0));
    let radiance = textureLoad(cascade_tex, coord, 0);
    return vec4f(linear_to_srgb(tonemap_aces(radiance.rgb * present.display.x)), 1.0);
  }
  if (view == 4) {
    let seed = textureLoad(jfa_tex, texel, 0);
    if (seed.a < 0.5) {
      return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    let encoded = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + seed.x * 0.055 + seed.y * 0.089);
    return vec4f(encoded, 1.0);
  }

  let irradiance = resolve_cascade0(pixel);
  let emitter = textureSampleLevel(emitter_tex, emitter_samp, scene_uv, 0.0);
  let vignette = 1.0 - 0.42 * smoothstep(0.16, 0.72, distance(uv, vec2f(0.5)));
  let surface = vec3f(present.lighting.x * vignette);
  let lit = mix(surface * (irradiance + present.lighting.y), emitter.rgb, clamp(emitter.a, 0.0, 1.0));
  return vec4f(linear_to_srgb(tonemap_aces(lit * present.display.x)), 1.0);
}

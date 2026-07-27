import { env_lod, sample_env } from "./env-common.wgsl";
import { decode_backface } from "./backface.wgsl";
import { DISPERSION_SAMPLES, spectral_weight } from "./dispersion.wgsl";
import { dielectric_fresnel } from "./fresnel.wgsl";
import { reflection_cone, transmission_lod } from "./lod-selection.wgsl";
import { project_to_uv, transmitted_ray } from "./refraction.wgsl";

// Screen-space transmission. The scene behind the cube was already rendered and blurred
// into a pyramid, so refraction is a lookup: bend the view ray through the glass, project
// where it lands back onto the screen, and read that pixel from the level whose blur
// matches the surface roughness. One fetch buys frosted glass; ray-tracing the same look
// would cost dozens of taps and still sparkle.
struct Glass {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
  /** Index of refraction. 1.5 is soda-lime glass. */
  ior: f32,
  /** 0 polished, 1 sandblasted: walks up the blurred pyramid of the scene. */
  roughness: f32,
  /** How far the ray travels inside the solid in `simple` mode, in world units. */
  thickness: f32,
  /** 1 splits the IOR per channel. */
  dispersion: f32,
  /** 0 refracts once at the front face, 1 also refracts at the back face. */
  refraction_mode: f32,
  /** Beer-Lambert absorption per world unit, per channel: the glass' own tint. */
  absorption: vec3f,
  /** Mip count of the scene pyramid; roughness 1 lands on the last one. */
  scene_levels: f32,
  env_size: vec2f,
  /** Angle covered by one texel of the environment map: 2*PI / map_width. */
  texel_angle: f32,
  /** Total IOR range swept from the red end of the spectrum to the blue one. */
  dispersion_spread: f32,
};
@group(0) @binding(0) var<uniform> glass: Glass;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var scene_samp: sampler;
@group(0) @binding(3) var env_tex: texture_2d<f32>;
@group(0) @binding(4) var env_samp: sampler;
@group(0) @binding(5) var backface_tex: texture_2d<f32>;
@group(0) @binding(6) var backface_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
  @location(1) world_normal: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  let world = glass.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = glass.view_projection * world;
  out.world_position = world.xyz;
  // `model` is rotation-only, so the normal needs no inverse-transpose.
  out.world_normal = (glass.model * vec4f(normal, 0.0)).xyz;
  return out;
}

/** Reads the scene pyramid where a transmitted ray lands, at the roughness level. */
fn sample_transmission(ray: vec4f, lod: f32, fallback: vec3f) -> vec3f {
  let uv = project_to_uv(glass.view_projection, ray.xyz);
  let clamped = clamp(uv, vec2f(0.001), vec2f(0.999));
  let scene = textureSampleLevel(scene_tex, scene_samp, clamped, lod).rgb;
  // Rays that never left the glass, or that land outside the frame, have no pixel to
  // read; the environment is the honest stand-in and matches what the surface reflects.
  // The handover ramps over the outer 6% of the frame instead of switching on one texel,
  // because a hard switch draws a visible contour across the glass wherever the
  // refracted ray happens to cross the border.
  let inside = smoothstep(vec2f(0.0), vec2f(0.06), uv) * smoothstep(vec2f(0.0), vec2f(0.06), 1.0 - uv);
  let usable = select(0.0, inside.x * inside.y, ray.w > 0.5);
  return mix(fallback, scene, usable);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let geometric_normal = normalize(in.world_normal);
  let view = normalize(glass.camera_position - in.world_position);
  // Front faces only reach this shader, but a normal flipped by a mirrored transform
  // would invert every refraction, so it is oriented against the view once, here.
  let normal = select(-geometric_normal, geometric_normal, dot(geometric_normal, view) > 0.0);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);

  // Both fetches use an explicit level, and both levels are computed before any branch:
  // derivatives are only well defined in uniform control flow.
  //
  // The reflection cone is driven by the same roughness as the transmission, and at full
  // width, not half: a sandblasted face that transmits a smear cannot reflect a crisp
  // horizon, and the seam between two faces is exactly where that mismatch shows.
  let reflected = reflect(incident, normal);
  let env_level = env_lod(reflection_cone(glass.roughness), dpdx(reflected), dpdy(reflected), glass.texel_angle);
  // Stopping two levels short of the top of the pyramid: the last mip of a screen-sized
  // target is a handful of texels, i.e. the average of the whole frame, and a face that
  // samples a constant reads as opaque paint rather than as frosted glass. One level down
  // still smears every edge away but keeps the floor-to-horizon gradient behind the cube.
  let scene_level = transmission_lod(glass.roughness, glass.scene_levels);

  // The backface pass stored the exit surface for this exact pixel: its outward normal,
  // and the camera distance that gives the true thickness of the solid along this ray.
  let screen_uv = project_to_uv(glass.view_projection, in.world_position);
  let back = textureSampleLevel(backface_tex, backface_samp, clamp(screen_uv, vec2f(0.001), vec2f(0.999)), 0.0);
  let front_distance = distance(in.world_position, glass.camera_position);

  // Roughness blurs the scene the ray lands on, but the far side of the solid is read
  // from a full-resolution buffer that no amount of roughness touches, so the projected
  // silhouette of the back edges stayed razor-sharp inside otherwise frosted glass. Fade
  // the second interface out as the surface roughens — a wide scattering cone averages
  // over the far geometry anyway — so rough glass converges on the single-interface
  // result and every internal edge dissolves with the rest of the image. `has_back` also
  // guards the silhouette pixels the backface pass never covered, where the stored normal
  // is the cleared zero vector.
  let decoded_backface = decode_backface(back, front_distance, normal, glass.thickness, glass.roughness, glass.refraction_mode > 0.5);
  let double_amount = decoded_backface.amount;
  let thickness = decoded_backface.thickness;
  let exit_normal = decoded_backface.normal;

  let reflection = sample_env(env_tex, env_samp, reflected, env_level, glass.env_size);

  // Dispersion as a spectral sweep, not three fringes: DISPERSION_SAMPLES wavelengths
  // walk the IOR from the red end (bends least) to the blue one, each transmitted
  // separately and accumulated under a smooth response curve. Splitting only R, G and B
  // puts all the energy on three indices, which reads as three hard-edged colour bands;
  // seven overlapping wavelengths land on seven neighbouring pixels and reconstruct a
  // continuous rainbow along the gradient instead.
  var transmitted: vec3f;
  if (glass.dispersion > 0.5) {
    var spectrum = vec3f(0.0);
    var total = vec3f(0.0);
    for (var i = 0; i < DISPERSION_SAMPLES; i = i + 1) {
      let t = (f32(i) + 0.5) / f32(DISPERSION_SAMPLES);
      let ior = glass.ior + (t - 0.5) * glass.dispersion_spread;
      let ray = transmitted_ray(in.world_position, incident, normal, 1.0 / ior, exit_normal, thickness, double_amount);
      let weight = spectral_weight(t);
      spectrum += sample_transmission(ray, scene_level, reflection) * weight;
      total += weight;
    }
    // Per-channel normalisation: the sweep redistributes light, it never adds or removes
    // any, so a uniform background has to come back out unchanged.
    transmitted = spectrum / max(total, vec3f(1e-4));
  } else {
    let ray = transmitted_ray(in.world_position, incident, normal, 1.0 / glass.ior, exit_normal, thickness, double_amount);
    transmitted = sample_transmission(ray, scene_level, reflection);
  }

  // Beer-Lambert: the further the ray travels inside the solid, the more of it the glass
  // keeps. This is what gives thick corners their colour while flat faces stay clear.
  transmitted *= exp(-glass.absorption * thickness);

  // Schlick against the dielectric's normal-incidence reflectance: glass is a window
  // head-on and a mirror at grazing angles, and that gradient is most of the read.
  let fresnel = dielectric_fresnel(glass.ior, facing);

  return vec4f(mix(transmitted, reflection, fresnel), 1.0);
}

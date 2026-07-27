import { env_lod, sample_env } from "./env-common.wgsl";
import { trace_cube_exit, transmitted_cube_inside_ray } from "./backface.wgsl";
import { cone_direction, cone_rotation, TRANSMISSION_SAMPLES } from "./cone.wgsl";
import { spectral_weight } from "./dispersion.wgsl";
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

  // Both fetches use explicit levels computed before branches, preserving uniform
  // derivative flow. Cone integration supplies the geometric blur, so the scene pyramid
  // contributes only the lower-frequency half instead of blurring the result twice.
  let reflected = reflect(incident, normal);
  let env_level = env_lod(reflection_cone(glass.roughness), dpdx(reflected), dpdy(reflected), glass.texel_angle);
  let scene_level = transmission_lod(glass.roughness, glass.scene_levels) * 0.55;

  let central_inside = refract(incident, normal, 1.0 / glass.ior);
  let central_exit = trace_cube_exit(glass.model, in.world_position, central_inside, 0.65);
  let double_amount = select(0.0, 1.0, glass.refraction_mode > 0.5);
  let thickness = mix(glass.thickness, central_exit.distance, double_amount);
  let reflection = sample_env(env_tex, env_samp, reflected, env_level, glass.env_size);

  // Eleven equal-area golden-angle samples form a deterministic cone. Roughness is
  // squared so polished glass remains sharp while the high end spreads across multiple
  // exit faces. In double mode every jittered inside direction traces its own cube exit.
  let cone_radius = glass.roughness * glass.roughness * 0.18;
  let rotation = cone_rotation(in.position.xy);
  var spectrum = vec3f(0.0);
  var total = vec3f(0.0);
  for (var i = 0; i < TRANSMISSION_SAMPLES; i = i + 1) {
    let t = (f32(i) + 0.5) / f32(TRANSMISSION_SAMPLES);
    let spectral_ior = max(1.0, glass.ior + (t - 0.5) * glass.dispersion_spread);
    let ior = select(glass.ior, spectral_ior, glass.dispersion > 0.5);
    let eta = 1.0 / ior;
    let base_inside = refract(incident, normal, eta);
    let inside = cone_direction(base_inside, i, cone_radius, rotation);
    let ray = transmitted_cube_inside_ray(glass.model, in.world_position, inside, eta, 0.65, glass.thickness, double_amount);
    let weight = select(vec3f(1.0), spectral_weight(t), glass.dispersion > 0.5);
    spectrum += sample_transmission(ray, scene_level, reflection) * weight;
    total += weight;
  }
  var transmitted = spectrum / max(total, vec3f(1e-4));

  // Beer-Lambert: the further the ray travels inside the solid, the more of it the glass
  // keeps. This is what gives thick corners their colour while flat faces stay clear.
  transmitted *= exp(-glass.absorption * thickness);

  // Schlick against the dielectric's normal-incidence reflectance: glass is a window
  // head-on and a mirror at grazing angles, and that gradient is most of the read.
  let fresnel = dielectric_fresnel(glass.ior, facing);

  return vec4f(mix(transmitted, reflection, fresnel), 1.0);
}

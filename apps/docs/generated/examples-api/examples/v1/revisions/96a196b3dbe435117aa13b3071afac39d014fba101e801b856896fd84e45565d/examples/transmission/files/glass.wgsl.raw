import { env_lod, sample_env } from "./env-common.wgsl";

const TRANSMISSION_SAMPLES: i32 = 11;
const GOLDEN_ANGLE: f32 = 2.39996323;

struct CubeExit {
  position: vec3f,
  normal: vec3f,
  distance: f32,
};

fn trace_cube_exit(model: mat4x4f, entry: vec3f, direction: vec3f, half_extent: f32) -> CubeExit {
  let rotation = mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz);
  let inverse_rotation = transpose(rotation);
  let local_entry = inverse_rotation * (entry - model[3].xyz);
  let local_direction = inverse_rotation * direction;
  let safe = sign(local_direction) * max(abs(local_direction), vec3f(1e-6));
  let boundary = sign(local_direction) * half_extent;
  let candidates = select(
    vec3f(1e6),
    (boundary - local_entry) / safe,
    abs(local_direction) > vec3f(1e-5),
  );
  let distance = min(candidates.x, min(candidates.y, candidates.z));
  var local_normal = vec3f(0.0);
  if (candidates.x <= candidates.y && candidates.x <= candidates.z) {
    local_normal.x = sign(local_direction.x);
  } else if (candidates.y <= candidates.z) {
    local_normal.y = sign(local_direction.y);
  } else {
    local_normal.z = sign(local_direction.z);
  }
  return CubeExit(
    entry + direction * distance,
    normalize(rotation * local_normal),
    distance,
  );
}

fn transmitted_cube_inside_ray(
  model: mat4x4f,
  entry: vec3f,
  inside: vec3f,
  eta: f32,
  half_extent: f32,
  fallback_thickness: f32,
  double_amount: f32,
) -> vec4f {
  if (dot(inside, inside) < 1e-6) {
    return vec4f(entry, 0.0);
  }
  if (double_amount < 1e-3) {
    return vec4f(entry + inside * (fallback_thickness + 4.0), 1.0);
  }
  let exit = trace_cube_exit(model, entry, inside, half_extent);
  let outgoing = refract(inside, -exit.normal, 1.0 / eta);
  if (dot(outgoing, outgoing) < 1e-6) {
    return vec4f(exit.position + inside * 4.0, 1.0);
  }
  return vec4f(exit.position + outgoing * 4.0, 1.0);
}

fn cone_rotation(pixel: vec2f) -> f32 {
  return fract(sin(dot(floor(pixel), vec2f(12.9898, 78.233))) * 43758.5453) * 6.28318531;
}

fn cone_direction(direction: vec3f, sample_index: i32, radius: f32, rotation: f32) -> vec3f {
  let axis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(direction.y) > 0.9);
  let tangent = normalize(cross(axis, direction));
  let bitangent = cross(direction, tangent);
  let disk_radius = sqrt((f32(sample_index) + 0.5) / f32(TRANSMISSION_SAMPLES));
  let angle = f32(sample_index) * GOLDEN_ANGLE + rotation;
  let offset = (cos(angle) * tangent + sin(angle) * bitangent) * disk_radius * radius;
  return normalize(direction + offset);
}

fn spectral_weight(t: f32) -> vec3f {
  return vec3f(
    exp(-pow((t - 0.05) / 0.45, 2.0)),
    exp(-pow((t - 0.50) / 0.38, 2.0)),
    exp(-pow((t - 0.95) / 0.45, 2.0)),
  );
}

fn dielectric_fresnel(ior: f32, facing: f32) -> f32 {
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  return f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
}

fn transmission_lod(roughness: f32, levels: f32) -> f32 {
  return pow(roughness, 0.8) * max(levels - 1.0, 0.0);
}

fn reflection_cone(roughness: f32) -> f32 {
  return max(roughness * 0.6, 0.02);
}

fn project_to_uv(view_projection: mat4x4f, world_position: vec3f) -> vec2f {
  let clip = view_projection * vec4f(world_position, 1.0);
  let ndc = clip.xy / max(clip.w, 1e-4);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// The glass bends rays into the pre-rendered scene pyramid and samples the level chosen
// by roughness. Reflection comes from the prefiltered environment pyramid.
struct Glass {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
  ior: f32,
  roughness: f32,
  thickness: f32,
  dispersion: f32,
  refraction_mode: f32,
  absorption: vec3f,
  scene_levels: f32,
  env_size: vec2f,
  texel_angle: f32,
  dispersion_spread: f32,
};
@group(0) @binding(0) var<uniform> glass: Glass;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var scene_samp: sampler;
@group(0) @binding(3) var env_tex: texture_2d<f32>;
@group(0) @binding(4) var env_samp: sampler;
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
  out.world_normal = (glass.model * vec4f(normal, 0.0)).xyz;
  return out;
}

fn sample_transmission(ray: vec4f, lod: f32, fallback: vec3f) -> vec3f {
  let uv = project_to_uv(glass.view_projection, ray.xyz);
  let clamped = clamp(uv, vec2f(0.001), vec2f(0.999));
  let scene = textureSampleLevel(scene_tex, scene_samp, clamped, lod).rgb;
  // Blend to the environment across the frame edge or when no ray exits the cube.
  let inside = smoothstep(vec2f(0.0), vec2f(0.06), uv)
    * smoothstep(vec2f(0.0), vec2f(0.06), 1.0 - uv);
  let usable = select(0.0, inside.x * inside.y, ray.w > 0.5);
  return mix(fallback, scene, usable);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let geometric_normal = normalize(in.world_normal);
  let view = normalize(glass.camera_position - in.world_position);
  let normal = select(-geometric_normal, geometric_normal, dot(geometric_normal, view) > 0.0);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);

  let reflected = reflect(incident, normal);
  let env_level = env_lod(
    reflection_cone(glass.roughness),
    dpdx(reflected),
    dpdy(reflected),
    glass.texel_angle,
  );
  let scene_level = transmission_lod(glass.roughness, glass.scene_levels) * 0.55;

  let central_inside = refract(incident, normal, 1.0 / glass.ior);
  let central_exit = trace_cube_exit(glass.model, in.world_position, central_inside, 0.65);
  let double_amount = select(0.0, 1.0, glass.refraction_mode > 0.5);
  let thickness = mix(glass.thickness, central_exit.distance, double_amount);
  let reflection = sample_env(env_tex, env_samp, reflected, env_level, glass.env_size);

  // Stable golden-angle samples spread across exit faces without temporal noise.
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
    let ray = transmitted_cube_inside_ray(
      glass.model,
      in.world_position,
      inside,
      eta,
      0.65,
      glass.thickness,
      double_amount,
    );
    let weight = select(vec3f(1.0), spectral_weight(t), glass.dispersion > 0.5);
    spectrum += sample_transmission(ray, scene_level, reflection) * weight;
    total += weight;
  }
  var transmitted = spectrum / max(total, vec3f(1e-4));

  transmitted *= exp(-glass.absorption * thickness);

  let fresnel = dielectric_fresnel(glass.ior, facing);

  return vec4f(mix(transmitted, reflection, fresnel), 1.0);
}

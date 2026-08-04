import { env_lod, sample_env } from "./env-common.wgsl";

// Mirror-metal cube shaded entirely from the environment map: one reflected ray per
// pixel, weighted by a conductor Fresnel term. No lights, no shadow maps — a polished
// metal surface is nothing but the environment seen from a different angle.
struct Uniforms {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
  /** Half-angle of the reflection cone, in radians. 0 is a perfect mirror. */
  roughness: f32,
  base_color: vec3f,
  /** Angle covered by one texel of the environment map: 2*PI / map_width. */
  texel_angle: f32,
  env_size: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var env_tex: texture_2d<f32>;
@group(0) @binding(2) var env_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
  @location(1) world_normal: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  let world = uniforms.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = uniforms.view_projection * world;
  out.world_position = world.xyz;
  // `model` is rotation-only, so the normal needs no inverse-transpose.
  out.world_normal = (uniforms.model * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.world_normal);
  let view = normalize(uniforms.camera_position - in.world_position);
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflected = reflect(-view, normal);

  // The environment ships as a prefiltered pyramid, so roughness is one texture fetch:
  // pick the level whose blur already matches the reflection cone. Tracing a cone with N
  // taps per pixel would cost N fetches and still band or sparkle; the pyramid paid for
  // the filtering once, at startup.
  let lod = env_lod(uniforms.roughness, dpdx(reflected), dpdy(reflected), uniforms.texel_angle);

  // Conductor Fresnel: `base_color` is the metal's normal-incidence reflectance, and
  // every metal turns into a white mirror at grazing angles.
  let fresnel = uniforms.base_color + (vec3f(1.0) - uniforms.base_color) * pow(1.0 - facing, 5.0);

  return vec4f(sample_env(env_tex, env_samp, reflected, lod, uniforms.env_size) * fresnel, 1.0);
}

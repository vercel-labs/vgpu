import { env_lod, sample_env } from "./env-common.wgsl";

struct Uniforms {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
  roughness: f32,
  base_color: vec3f,
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
  out.world_normal = (uniforms.model * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.world_normal);
  let view = normalize(uniforms.camera_position - in.world_position);
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflected = reflect(-view, normal);

  let lod = env_lod(uniforms.roughness, dpdx(reflected), dpdy(reflected), uniforms.texel_angle);

  let fresnel = uniforms.base_color + (vec3f(1.0) - uniforms.base_color) * pow(1.0 - facing, 5.0);

  return vec4f(sample_env(env_tex, env_samp, reflected, lod, uniforms.env_size) * fresnel, 1.0);
}

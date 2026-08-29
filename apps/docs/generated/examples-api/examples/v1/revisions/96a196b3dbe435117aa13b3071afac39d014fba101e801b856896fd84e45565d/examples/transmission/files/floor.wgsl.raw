import { env_lod, sample_env } from "./env-common.wgsl";

// A real depth-tested checker plane makes refraction distance legible.
struct Floor {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
};
@group(0) @binding(0) var<uniform> floor_uniforms: Floor;
@group(0) @binding(1) var env_tex: texture_2d<f32>;
@group(0) @binding(2) var env_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world_position: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f) -> VertexOut {
  let world = floor_uniforms.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = floor_uniforms.view_projection * world;
  out.world_position = world.xyz;
  return out;
}

fn checker_box(p: vec2f, w: vec2f) -> f32 {
  let i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
  return 0.5 - 0.5 * i.x * i.y;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = vec3f(0.0, 1.0, 0.0);
  let to_camera = floor_uniforms.camera_position - in.world_position;
  let view_distance = length(to_camera);
  let view = to_camera / max(view_distance, 1e-4);

  let tile = in.world_position.xz * 0.85;
  let checker = checker_box(tile, fwidth(tile) + vec2f(1e-3));
  var color = vec3f(0.052, 0.055, 0.062) * (0.55 + checker * 1.5);

  let sun = normalize(vec3f(-0.724, 0.09, -0.684));
  color *= 0.55 + 0.45 * clamp(sun.y, 0.0, 1.0) * clamp(dot(normal, sun) * 0.5 + 0.5, 0.0, 1.0);

  let reflected = reflect(-view, normal);
  let lod = env_lod(0.045, dpdx(reflected), dpdy(reflected), 0.003067961661145091);
  let reflection = sample_env(env_tex, env_samp, reflected, lod, vec2f(2048.0, 1024.0));
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
  color = mix(color, reflection, fresnel * 0.85);

  let fade = clamp(view_distance / 26.0, 0.0, 1.0);
  color = mix(color, vec3f(0.36, 0.48, 0.74), fade * fade);

  return vec4f(color, 1.0);
}

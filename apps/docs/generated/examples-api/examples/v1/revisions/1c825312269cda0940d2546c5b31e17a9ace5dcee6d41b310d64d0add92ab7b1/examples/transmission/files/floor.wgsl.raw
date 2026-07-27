import { env_lod, sample_env } from "./env-common.wgsl";

// The floor is real geometry, not a trick inside the sky shader: a plane mesh rasterized
// with depth, so it occludes the cube when the camera drops below it and, more
// importantly, so the checker it refracts is a surface at a known distance instead of a
// direction at infinity. Its checker is the ruler the whole example is read against.
struct Floor {
  view_projection: mat4x4f,
  model: mat4x4f,
  camera_position: vec3f,
  /** Tiles per world unit. */
  checker_scale: f32,
  sun_direction: vec3f,
  /** Half-angle of the floor's reflection cone, in radians. */
  reflection_roughness: f32,
  horizon_color: vec3f,
  /** Angle covered by one texel of the environment map: 2*PI / map_width. */
  texel_angle: f32,
  base_color: vec3f,
  /** Distance where the checker has faded fully into the horizon haze. */
  fade_distance: f32,
  env_size: vec2f,
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

// Box-filtered checkerboard (iq): the pattern is integrated over the pixel's footprint
// instead of point-sampled, so the tiles stay antialiased all the way to the horizon
// without a single extra tap.
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

  let tile = in.world_position.xz * floor_uniforms.checker_scale;
  let checker = checker_box(tile, fwidth(tile) + vec2f(1e-3));
  var color = floor_uniforms.base_color * (0.55 + checker * 1.5);

  // Soft key from the same sun the sky bakes, plus a flat sky ambient. Enough shaping to
  // read as a lit surface; the interesting light in this scene is the transmitted kind.
  let sun = normalize(floor_uniforms.sun_direction);
  color *= 0.55 + 0.45 * clamp(sun.y, 0.0, 1.0) * clamp(dot(normal, sun) * 0.5 + 0.5, 0.0, 1.0);

  // A dielectric floor is mostly diffuse but never matte: the grazing sky reflection is
  // what glues the plane to the environment behind it.
  let reflected = reflect(-view, normal);
  let lod = env_lod(floor_uniforms.reflection_roughness, dpdx(reflected), dpdy(reflected), floor_uniforms.texel_angle);
  let reflection = sample_env(env_tex, env_samp, reflected, lod, floor_uniforms.env_size);
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
  color = mix(color, reflection, fresnel * 0.85);

  // The plane is finite; fading it into the environment's own horizon haze hides the far
  // edge where the mesh stops and the baked sky takes over.
  let fade = clamp(view_distance / floor_uniforms.fade_distance, 0.0, 1.0);
  color = mix(color, floor_uniforms.horizon_color, fade * fade);

  return vec4f(color, 1.0);
}

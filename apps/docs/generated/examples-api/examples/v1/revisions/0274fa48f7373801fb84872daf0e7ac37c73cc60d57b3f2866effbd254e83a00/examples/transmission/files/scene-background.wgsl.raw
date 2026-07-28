import { env_lod, sample_env } from "./env-common.wgsl";

// The sky behind everything, written straight into the linear HDR scene target: one
// primary ray per pixel, one fetch from the prefiltered environment pyramid. It runs
// before the floor and the glass so both can be depth-tested against it, and it is the
// same map the cube reflects, so reflections line up with the background.
struct SceneCamera {
  position: vec3f,
  tan_half_fov: f32,
  forward: vec3f,
  aspect: f32,
  right: vec3f,
  /** Angle covered by one texel of the environment map: 2*PI / map_width. */
  texel_angle: f32,
  up: vec3f,
  intensity: f32,
  env_size: vec2f,
};
@group(0) @binding(0) var<uniform> scene_camera: SceneCamera;
@group(0) @binding(1) var env_tex: texture_2d<f32>;
@group(0) @binding(2) var env_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// Fullscreen triangle, not a fullscreen effect: the scene target owns a depth buffer, and
// the sky has to land on the far plane (z = 1) without writing depth, so the floor mesh
// still passes the test everywhere.
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[vertex_index];
  var out: VertexOut;
  out.position = vec4f(corner, 1.0, 1.0);
  out.uv = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // `uv` is top-origin, so y is flipped once here to build a y-up NDC ray.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let direction = normalize(
    scene_camera.forward
      + scene_camera.right * (ndc.x * scene_camera.tan_half_fov * scene_camera.aspect)
      + scene_camera.up * (ndc.y * scene_camera.tan_half_fov),
  );

  // Mirror case of the roughness pyramid: no cone, only the pixel's own angular
  // footprint, which is what keeps the distant sky and clouds from shimmering.
  let lod = env_lod(0.0, dpdx(direction), dpdy(direction), scene_camera.texel_angle);
  let color = sample_env(env_tex, env_samp, direction, lod, scene_camera.env_size);

  return vec4f(color * scene_camera.intensity, 1.0);
}

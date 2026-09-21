import { env_lod, sample_env } from "./env-common.wgsl";

// Reconstruct one camera ray per pixel and sample the same environment the glass reflects.
struct SceneCamera {
  tan_half_fov: f32,
  forward: vec3f,
  aspect: f32,
  right: vec3f,
  up: vec3f,
};
@group(0) @binding(0) var<uniform> scene_camera: SceneCamera;
@group(0) @binding(1) var env_tex: texture_2d<f32>;
@group(0) @binding(2) var env_samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

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
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let direction = normalize(
    scene_camera.forward
      + scene_camera.right * (ndc.x * scene_camera.tan_half_fov * scene_camera.aspect)
      + scene_camera.up * (ndc.y * scene_camera.tan_half_fov),
  );

  let lod = env_lod(0.0, dpdx(direction), dpdy(direction), 0.003067961661145091);
  let color = sample_env(env_tex, env_samp, direction, lod, vec2f(2048.0, 1024.0));

  return vec4f(color, 1.0);
}

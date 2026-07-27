import { env_lod, linear_to_srgb, sample_env, tonemap_aces } from "./env-common.wgsl";

// Background + composite + tonemap in one fullscreen pass. The background is the same
// environment map the cube reflects, sampled along the primary camera ray, so the
// reflections line up with what is behind the cube.
struct Camera {
  position: vec3f,
  tan_half_fov: f32,
  forward: vec3f,
  aspect: f32,
  right: vec3f,
  exposure: f32,
  up: vec3f,
  background_intensity: f32,
  /** Angle covered by one texel of the environment map: 2*PI / map_width. */
  texel_angle: f32,
  env_size: vec2f,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var env_tex: texture_2d<f32>;
@group(0) @binding(2) var env_samp: sampler;
@group(0) @binding(3) var scene_tex: texture_2d<f32>;
@group(0) @binding(4) var scene_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // `uv` is top-origin, so y is flipped once here to build a y-up NDC ray.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let direction = normalize(
    camera.forward
      + camera.right * (ndc.x * camera.tan_half_fov * camera.aspect)
      + camera.up * (ndc.y * camera.tan_half_fov),
  );

  // Same pyramid, mirror case: no cone, only the pixel footprint. Toward the horizon one
  // pixel spans many texels of floor, and picking the matching mip is what keeps the
  // checkerboard from shimmering.
  let lod = env_lod(0.0, dpdx(direction), dpdy(direction), camera.texel_angle);
  let background = sample_env(env_tex, env_samp, direction, lod, camera.env_size) * camera.background_intensity;

  // The cube pass clears to alpha 0, so alpha is the cube's coverage mask.
  let scene = textureSample(scene_tex, scene_samp, uv);
  let color = mix(background, scene.rgb, scene.a);

  return vec4f(linear_to_srgb(tonemap_aces(color * camera.exposure)), 1.0);
}

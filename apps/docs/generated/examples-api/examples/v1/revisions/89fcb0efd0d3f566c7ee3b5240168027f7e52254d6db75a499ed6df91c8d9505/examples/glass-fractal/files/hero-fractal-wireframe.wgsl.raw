import {
  heroFractalFacePosition,
  heroFractalSkillRotation,
  heroFractalSphereMix,
  heroFractalSpherePosition,
} from "./hero-fractal-face-instance.wgsl";

struct Params {
  viewProjection: mat4x4f,
  model: mat4x4f,
  meshMin: vec3f,
  meshMax: vec3f,
  sphereMix: f32,
  time: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
  @location(2) packed_sphere: vec4f,
  @builtin(instance_index) instance: u32,
) -> @builtin(position) vec4f {
  let decodedPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  let sphereMix = heroFractalSphereMix(decodedPosition, params.sphereMix);
  let fractalPosition = heroFractalFacePosition(decodedPosition, instance);
  let sphereSourcePosition = heroFractalFacePosition(
    packed_sphere.xyz,
    instance,
  );
  let localPosition = heroFractalSkillRotation(sphereMix) * mix(
      fractalPosition,
      heroFractalSpherePosition(sphereSourcePosition, params.time),
      sphereMix,
    );
  _ = packed_normal;
  return params.viewProjection * params.model * vec4f(localPosition, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  let alpha = 0.82;
  return vec4f(vec3f(0.0, 0.72, 1.0) * alpha, alpha);
}

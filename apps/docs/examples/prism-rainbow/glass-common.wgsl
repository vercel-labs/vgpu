// Uniform layout and optical helpers shared by the two glass interfaces.

import { rotateEnvironmentDirection, sampleStudioEnvironment } from "./environment.wgsl";

export struct Glass {
  viewProjection: mat4x4f,
  environmentRotation: mat4x4f,
  cameraPosition: vec3f,
  /** Beer-Lambert absorption per scene unit, in linear RGB. */
  absorption: vec3f,
  /** The cross-section, wound counter-clockwise, as `types.ts` derives it. */
  prismA: vec2f,
  prismB: vec2f,
  prismC: vec2f,
  resolution: vec2f,
  frontZ: f32,
  backZ: f32,
  /** The wall is a plane behind the prism, perpendicular to the z axis. */
  wallZ: f32,
  ior: f32,
  reflectionStrength: f32,
  frostRadius: f32,
  dispersion: f32,
  iridescenceStrength: f32,
  iridescenceFrequency: f32,
  environmentExposure: f32,
}

export fn glassEnvironment(direction: vec3f, params: Glass) -> vec3f {
  return sampleStudioEnvironment(
    rotateEnvironmentDirection(direction, params.environmentRotation),
  ) * params.environmentExposure;
}

export fn dielectricFresnel(ior: f32, facing: f32) -> f32 {
  let ratio = (ior - 1.0) / (ior + 1.0);
  let f0 = ratio * ratio;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(facing, 0.0, 1.0), 5.0);
}

export fn projectToUv(point: vec3f, viewProjection: mat4x4f) -> vec2f {
  let clip = viewProjection * vec4f(point, 1.0);
  let ndc = clip.xy / max(clip.w, 0.00001);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

export fn sampleScene(
  sceneTexture: texture_2d<f32>,
  sceneSampler: sampler,
  uv: vec2f,
  halfTexel: vec2f,
) -> vec3f {
  let safeUv = clamp(uv, halfTexel, vec2f(1.0) - halfTexel);
  return textureSampleLevel(sceneTexture, sceneSampler, safeUv, 0.0).rgb;
}

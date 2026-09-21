// A perfect mirror sampling the same baked debug texture as the prism.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { env_lod, sample_env } from "./environment-map-common.wgsl";
import { rotateEnvironmentDirection } from "./environment.wgsl";

struct Params {
  viewProjection: mat4x4f,
  environmentRotation: mat4x4f,
  cameraPosition: vec3f,
  environmentExposure: f32,
  environmentSize: vec2f,
  environmentTexelAngle: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var environmentTexture: texture_2d<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> VertexOut {
  var out: VertexOut;
  out.clip = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  let reflected = reflect(-view, normalize(in.worldNormal));
  let lod = clamp(
    env_lod(
      0.0,
      dpdx(reflected),
      dpdy(reflected),
      params.environmentTexelAngle,
    ),
    0.0,
    f32(textureNumLevels(environmentTexture) - 1u),
  );
  let radiance = sample_env(
    environmentTexture,
    environmentSampler,
    rotateEnvironmentDirection(reflected, params.environmentRotation),
    lod,
    params.environmentSize,
  ) * params.environmentExposure;
  return vec4f(linearToSrgb3(tonemapAces(radiance)), 1.0);
}

import { presentCeramic } from "./hero-fractal-ceramic.wgsl";
import {
  rotateHeroEnvironmentDirection,
  sampleHeroEnvironment,
} from "./hero-glass-environment.wgsl";

struct Params {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  environmentRotation: mat4x4f,
  environmentExposure: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var environmentTexture: texture_2d_array<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> VertexOut {
  let world = params.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(normal, 0.0)).xyz);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  let reflected = reflect(-view, normalize(in.worldNormal));
  let environment = sampleHeroEnvironment(
    environmentTexture,
    environmentSampler,
    rotateHeroEnvironmentDirection(reflected, params.environmentRotation),
  ) * params.environmentExposure;
  return presentCeramic(environment);
}

// Shades day/night, procedural clouds, sunset, and atmospheric fresnel.

import { fbm3, saturate, valueRemap } from "./planet-common.wgsl";

const PI: f32 = 3.141592653589793;
const NIGHT_LIGHT_COLOR = vec3f(1.0, 0.72, 0.36);
const SUNSET_CLOUD_COLOR = vec3f(0.525, 0.273, 0.249);
const ATMOSPHERE_COLOR = vec3f(0.51, 0.714, 1.0);
const ATMOSPHERE_SUNSET_COLOR = vec3f(1.0, 0.373, 0.349);
const CLOUD_COLOR = vec3f(0.9);
const CLOUD_NORMAL_SCALE: f32 = 0.01;

struct EarthUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  lightDirection: vec3f,
};

@group(0) @binding(0) var<uniform> earth: EarthUniforms;
@group(0) @binding(1) var surfaceMap: texture_2d<f32>;
@group(0) @binding(2) var cloudMap: texture_2d<f32>;
@group(0) @binding(3) var mapSampler: sampler;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.world = input.position;
  out.normal = input.normal;
  out.uv = input.uv;
  out.clip = earth.viewProjection * vec4f(input.position, 1.0);
  return out;
}

fn curveUp(x: f32, factor: f32) -> f32 {
  return (1.0 - factor / (x + factor)) * (factor + 1.0);
}

fn cloudSlope(uv: vec2f, scale: f32) -> vec2f {
  let scaled = scale / 10.0;
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  let center = scaled * textureSample(cloudMap, mapSampler, uv).r;
  return vec2f(
    scaled * textureSample(cloudMap, mapSampler, uv + dx).r - center,
    scaled * textureSample(cloudMap, mapSampler, uv + dy).r - center,
  );
}

fn perturbNormal(surfacePosition: vec3f, surfaceNormal: vec3f, slope: vec2f) -> vec3f {
  let sigmaX = dpdx(surfacePosition);
  let sigmaY = dpdy(surfacePosition);
  let r1 = cross(sigmaY, surfaceNormal);
  let r2 = cross(surfaceNormal, sigmaX);
  let determinant = dot(sigmaX, r1);
  let gradient = sign(determinant) * (slope.x * r1 + slope.y * r2);
  return normalize(abs(determinant) * surfaceNormal - gradient);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let lightDirection = normalize(earth.lightDirection);
  let normal = normalize(input.normal);
  let toCamera = earth.cameraPosition - input.world;
  let viewDirection = normalize(toCamera);
  let distanceToCamera = length(toCamera);

  let surface = textureSample(surfaceMap, mapSampler, input.uv);
  let slope = cloudSlope(input.uv, CLOUD_NORMAL_SCALE);
  var result = vec3f(0.0);

  let rawLambert = dot(normal, lightDirection);
  let rawSunLight = valueRemap(rawLambert, -0.1, 0.1, 0.0, 1.0);
  let sunLight = saturate(rawSunLight);
  result = surface.rgb * sunLight;

  let nightFade = saturate(valueRemap(rawSunLight, 0.0, 0.15, 0.0, 1.0));
  result = result + NIGHT_LIGHT_COLOR * surface.a * (1.0 - nightFade);

  let distanceFactor = saturate(1.0 - distanceToCamera);
  var noiseFactor = 0.0;
  if (distanceFactor > 0.0) {
    let rotation = earth.time * 0.005;
    let rotated = vec3f(
      input.world.x * cos(rotation) - input.world.z * sin(rotation),
      input.world.y,
      input.world.x * sin(rotation) + input.world.z * cos(rotation),
    );
    noiseFactor = valueRemap(fbm3(rotated * 100.0, 4), -1.0, 1.0, 0.0, 1.0) * 0.5 * distanceFactor;
  }

  var cloudFactor = textureSample(cloudMap, mapSampler, input.uv).r;
  let cloudNoiseFactor = saturate(valueRemap(cloudFactor, 0.0, 0.5, 0.5, 1.0) * noiseFactor);
  cloudFactor = saturate(cloudFactor - cloudNoiseFactor);

  let cloudNormal = perturbNormal(input.world, normal, slope);
  let cloudNormalFactor = dot(cloudNormal, lightDirection);
  let cloudShadowFactor = curveUp(clamp(valueRemap(cloudNormalFactor, 0.0, 0.3, 0.3, 1.0), 0.3, 1.0), 0.5);
  var cloudColor = CLOUD_COLOR * cloudShadowFactor;

  var sunsetFactor = clamp(valueRemap(rawSunLight, -0.1, 0.85, -1.0, 1.0), -1.0, 1.0);
  sunsetFactor = cos(sunsetFactor * PI) * 0.5 + 0.5;
  let sunsetCloudFactor = pow(cloudFactor, 1.5) * sunsetFactor;
  cloudColor = cloudColor * clamp(sunLight, 0.1, 1.0);
  cloudColor = mix(cloudColor, SUNSET_CLOUD_COLOR, sunsetCloudFactor);
  result = mix(result, cloudColor, cloudFactor);

  let fresnelFactor = 0.1 + 0.5 * pow(1.0 - dot(normal, viewDirection), 3.0);
  let fresnelSunsetFactor = saturate(valueRemap(dot(-lightDirection, viewDirection), 0.97, 1.0, 0.0, 1.0));
  let atmosphere = mix(ATMOSPHERE_COLOR, ATMOSPHERE_SUNSET_COLOR, fresnelSunsetFactor);
  result = mix(result, atmosphere, fresnelFactor * sunLight);

  return vec4f(clamp(result * 0.9, vec3f(0.0), vec3f(0.7)), 1.0);
}

import { Atmosphere, Camera, FrameConstants, PI, TERRAIN_TRANSMITTANCE_ENTRIES, sampleTransmittance, skyViewUv } from "./atmosphere-common.wgsl";
import { TERRAIN_MAX_DISTANCE, TERRAIN_MAX_HEIGHT, sampleTerrainHeight } from "./terrain.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var<storage, read_write> frameConstants: FrameConstants;
@group(0) @binding(6) var terrainMap: texture_2d<f32>;

/**
 * Fraction of the solar disc visible above the terrain horizon. The minimum
 * ray-to-heightfield clearance becomes an angular clearance at the camera,
 * which gives a stable penumbra over the real angular radius of the sun.
 */
fn terrainSunVisibility(p: Atmosphere) -> f32 {
  let origin = camera.position;
  let dir = p.sunDirection;
  var minimumAngularClearance = 1e9;
  var t = 0.02;
  for (var i = 0; i < 200; i += 1) {
    if (t > TERRAIN_MAX_DISTANCE) { break; }
    let position = origin + dir * t;
    let altitude = length(position) - p.groundRadius;
    if (altitude > TERRAIN_MAX_HEIGHT && dir.y >= 0.0) { break; }
    let clearance = altitude - sampleTerrainHeight(terrainMap, lutSampler, position.xz);
    minimumAngularClearance = min(minimumAngularClearance, clearance / t);
    let distanceStep = 0.012 + t * 0.035;
    t += max(0.5 * distanceStep, min(max(clearance, 0.0) * 0.7, distanceStep));
  }
  return smoothstep(-camera.sunAngularRadius, camera.sunAngularRadius, minimumAngularClearance);
}

/**
 * One workgroup per frame. Every scalar expression here is copied verbatim from the pass that used to evaluate it
 * per pixel, so those values are bit-identical. Runs before the sky-view pass, so skyAmbient reads last frame's LUT.
 * Each thread also bakes one entry of the terrain sun-transmittance table.
 */
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) local: vec3u) {
  let p = atmosphere;
  let entryHeight = f32(local.x) / f32(TERRAIN_TRANSMITTANCE_ENTRIES - 1u) * TERRAIN_MAX_HEIGHT;
  frameConstants.terrainSunTransmittance[local.x] = vec4f(sampleTransmittance(p, transmittanceLut, lutSampler, p.groundRadius + entryHeight, p.sunDirection.y), 0.0);
  if (local.x != 0u) { return; }
  let viewHeight = length(camera.position);
  let up = camera.position / viewHeight;
  let vHorizon = sqrt(max(0.0, viewHeight * viewHeight - p.groundRadius * p.groundRadius));
  let beta = acos(clamp(vHorizon / viewHeight, -1.0, 1.0));
  let sunHorizontal = p.sunDirection - up * dot(p.sunDirection, up);
  let radius = camera.sunAngularRadius;
  frameConstants.skyAmbient = textureSampleLevel(skyViewLut, lutSampler, skyViewUv(p, viewHeight, 0.5, 0.0, false), 0.0).rgb;
  frameConstants.sunCosRadius = cos(radius);
  frameConstants.groundBounce = 0.15 * p.sunIlluminance * sampleTransmittance(p, transmittanceLut, lutSampler, p.groundRadius, p.sunDirection.y) * max(p.sunDirection.y, 0.0) / PI;
  frameConstants.sunSinRadius = sin(radius);
  frameConstants.sunHorizontal = sunHorizontal;
  frameConstants.sunHorizontalLength = length(sunHorizontal);
  frameConstants.beta = beta;
  frameConstants.zenithHorizonAngle = PI - beta;
  frameConstants.sunSolidAngle = PI * sin(radius) * sin(radius);
  frameConstants.sunTerrainVisibility = terrainSunVisibility(p);
}

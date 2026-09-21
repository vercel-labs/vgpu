import { AERIAL_KM_PER_SLICE, AERIAL_LUT_DEPTH, AERIAL_MAX_DISTANCE, Atmosphere, Camera, SunShadow, cameraRay, raySphere, sunShadowSample } from "./atmosphere-common.wgsl";
import { TERRAIN_NEAR } from "./terrain.wgsl";
import { Clouds, sampleCloudShadow } from "./clouds-common.wgsl";
import { HazeUpdate } from "./haze-temporal.wgsl";

@group(0) @binding(13) var cloudShadowNearMap: texture_2d<f32>;

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> clouds: Clouds;
@group(0) @binding(3) var<uniform> update: HazeUpdate;
@group(0) @binding(4) var aerialDirectLut: texture_3d<f32>;
@group(0) @binding(5) var lutSampler: sampler;
@group(0) @binding(6) var terrainDepth: texture_2d<f32>;
@group(0) @binding(7) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(8) var sunShadowMap0: texture_depth_2d;
@group(0) @binding(9) var sunShadowMap1: texture_depth_2d;
@group(0) @binding(10) var sunShadowMap2: texture_depth_2d;
@group(0) @binding(11) var shadowSampler: sampler_comparison;
@group(0) @binding(12) var<uniform> sunShadow: SunShadow;

fn sampleAerialDirect(uv: vec2f, distance: f32) -> vec3f {
  let slice = distance / AERIAL_KM_PER_SLICE;
  let weight = saturate(slice * 2.0);
  let w = sqrt(max(slice, 0.5) / AERIAL_LUT_DEPTH);
  return weight * textureSampleLevel(aerialDirectLut, lutSampler, vec3f(uv, w), 0.0).rgb;
}

@fragment fn fs_main(@builtin(position) fragCoord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let dir = cameraRay(camera, vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0));
  let depth = textureLoad(terrainDepth, vec2i(fragCoord.xy), 0).r;
  var distance = raySphere(camera.position, dir, atmosphere.groundRadius);
  if (depth > 0.0) { distance = TERRAIN_NEAR / (depth * dot(dir, camera.forward)); }
  let tEnd = select(AERIAL_MAX_DISTANCE, min(distance, AERIAL_MAX_DISTANCE), distance >= 0.0);
  // Interleaved gradient noise spreads neighbouring samples across the interval. A golden-ratio rotation changes
  // the strata each frame, so history actually integrates new samples instead of preserving a fixed grain pattern.
  let spatial = fract(52.9829189 * fract(dot(fragCoord.xy, vec2f(0.06711056, 0.00583715))));
  let noise = fract(spatial + update.phase);
  var loss = vec3f(0.0);
  var previous = vec3f(0.0);
  var previousT = 0.0;
  for (var i = 1; i <= 32; i += 1) {
    let f = f32(i) / 32.0;
    let t = min(f * f * AERIAL_MAX_DISTANCE, tEnd);
    let cumulative = sampleAerialDirect(uv, t);
    let increment = cumulative - previous;
    previous = cumulative;
    let position = camera.position + dir * mix(previousT, t, noise);
    previousT = t;
    let fromGround = position - vec3f(0.0, atmosphere.groundRadius, 0.0);
    var lit = sunShadowSample(sunShadow, sunShadowMap0, sunShadowMap1, sunShadowMap2, shadowSampler, fromGround, 1.0);
    if (length(position) - atmosphere.groundRadius < clouds.bottom) {
      lit *= sampleCloudShadow(clouds, sunShadow, cloudShadowNearMap, cloudShadowMap, lutSampler, fromGround);
    }
    loss += increment * (1.0 - lit);
    if (t >= tEnd) { break; }
  }
  // Keep the geometry distance for the bilateral resolve; -1 identifies sky, even beyond the march's range.
  return vec4f(max(loss, vec3f(0.0)), distance);
}

import { AERIAL_KM_PER_SLICE, AERIAL_LUT_DEPTH, AERIAL_LUT_HEIGHT, AERIAL_LUT_WIDTH, Atmosphere, Camera, PLANET_RADIUS_OFFSET, SunShadow, cameraRay, meanTransmittance, miePhase, rayleighPhase, raySphere, sampleMedium, sampleMultiScatter, sampleTransmittance, sunShadowSample } from "./atmosphere-common.wgsl";
import { Clouds, sampleCloudShadow } from "./clouds-common.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multiScatterLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var aerialLut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var sunShadowMap0: texture_depth_2d;
@group(0) @binding(7) var aerialUnshadowedLut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(14) var aerialDirectLut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(8) var<uniform> clouds: Clouds;
@group(0) @binding(9) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(10) var shadowSampler: sampler_comparison;
@group(0) @binding(11) var<uniform> sunShadow: SunShadow;
@group(0) @binding(12) var sunShadowMap1: texture_depth_2d;
@group(0) @binding(13) var sunShadowMap2: texture_depth_2d;

struct AerialResult { luminance: vec3f, unshadowed: vec3f, direct: vec3f, transmittance: vec3f };

/**
 * The integrateScattering loop of atmosphere-common.wgsl (Mie/Rayleigh phase, multiple scattering, no ground), kept
 * three ways. `unshadowed` and `direct` (its single-scattering part alone) are what the scene pass reads: it shadows the
 * single scattering itself, per pixel, against the sun's cascades and the cloud map, since a froxel column is far too
 * coarse for a shadow edge. `luminance` is shadowed here per sample (one depth comparison, last frame's map, and the
 * cloud map under the layer) for the cloud pass, whose texels only need a tint. The multiple-scattering ambient stays
 * unshadowed everywhere.
 */
fn integrateAerial(p: Atmosphere, origin: vec3f, dir: vec3f, tMaxMax: f32, sampleCount: f32) -> AerialResult {
  var result = AerialResult(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(1.0));
  let tBottom = raySphere(origin, dir, p.groundRadius);
  let tTop = raySphere(origin, dir, p.atmosphereRadius);
  var tMax = 0.0;
  if (tBottom < 0.0) {
    if (tTop < 0.0) { return result; }
    tMax = tTop;
  } else {
    tMax = tBottom;
    if (tTop > 0.0) { tMax = min(tTop, tBottom); }
  }
  tMax = min(tMax, tMaxMax);

  let cosTheta = dot(dir, p.sunDirection);
  let phaseMie = miePhase(p.mieG, cosTheta);
  let phaseRayleigh = rayleighPhase(cosTheta);
  let dt = tMax / sampleCount;
  var throughput = vec3f(1.0);
  for (var i = 0.0; i < sampleCount; i += 1.0) {
    let t = (i + 0.3) * dt;
    let position = origin + t * dir;
    let medium = sampleMedium(p, position);
    let viewHeight = length(position);
    let up = position / viewHeight;
    let sunZenithCos = dot(p.sunDirection, up);
    let sunTransmittance = sampleTransmittance(p, transmittanceLut, lutSampler, viewHeight, sunZenithCos);
    let earthShadow = select(1.0, 0.0, raySphere(position + up * PLANET_RADIUS_OFFSET, p.sunDirection, p.groundRadius) >= 0.0);
    let fromGround = position - vec3f(0.0, p.groundRadius, 0.0);
    var lit = sunShadowSample(sunShadow, sunShadowMap0, sunShadowMap1, sunShadowMap2, shadowSampler, fromGround, 1.0);
    // The cloud shadow map is one light ray per texel, so the air below the layer reads exactly its own column.
    if (viewHeight - p.groundRadius < clouds.bottom) { lit *= sampleCloudShadow(clouds, sunShadow, cloudShadowMap, lutSampler, fromGround); }
    let multiScatter = sampleMultiScatter(p, multiScatterLut, lutSampler, viewHeight, sunZenithCos);
    let direct = p.sunIlluminance * (earthShadow * sunTransmittance * (medium.mie * phaseMie + medium.rayleigh * phaseRayleigh));
    let ambient = p.sunIlluminance * (multiScatter * medium.scattering);
    let extinction = max(medium.extinction, vec3f(1e-7));
    let stepTransmittance = exp(-extinction * dt);
    let integral = throughput * (1.0 - stepTransmittance) / extinction;
    result.luminance += (direct * lit + ambient) * integral;
    result.unshadowed += (direct + ambient) * integral;
    result.direct += direct * integral;
    throughput *= stepTransmittance;
  }
  result.transmittance = throughput;
  return result;
}

/** Froxel volume: xy = screen, z = quadratic depth slices. rgb = in-scattered luminance, a = 1 - transmittance. */
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = atmosphere;
  let uv = (vec2f(id.xy) + 0.5) / vec2f(AERIAL_LUT_WIDTH, AERIAL_LUT_HEIGHT);
  let dir = cameraRay(camera, vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0));
  var slice = (f32(id.z) + 0.5) / AERIAL_LUT_DEPTH;
  slice = slice * slice * AERIAL_LUT_DEPTH;
  let tMax = slice * AERIAL_KM_PER_SLICE;
  let sampleCount = max(1.0, f32(id.z + 1u) * 2.0);
  let result = integrateAerial(p, camera.position, dir, tMax, sampleCount);
  let opacity = 1.0 - meanTransmittance(result.transmittance);
  textureStore(aerialLut, id, vec4f(result.luminance, opacity));
  textureStore(aerialUnshadowedLut, id, vec4f(result.unshadowed, opacity));
  textureStore(aerialDirectLut, id, vec4f(result.direct, 0.0));
}

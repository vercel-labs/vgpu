// Shared atmosphere model: Hillaire 2020 ("A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"). All distances are kilometres, planet centre is the origin.

export const PI: f32 = 3.14159265358979;
export const PLANET_RADIUS_OFFSET: f32 = 0.01;
export const TRANSMITTANCE_LUT_WIDTH: f32 = 256.0;
export const TRANSMITTANCE_LUT_HEIGHT: f32 = 64.0;
export const MULTISCATTER_LUT_SIZE: f32 = 32.0;
export const SKY_VIEW_LUT_WIDTH: f32 = 192.0;
export const SKY_VIEW_LUT_HEIGHT: f32 = 108.0;
/** Froxel volume: screen columns at roughly the display aspect, quadratic depth slices. */
export const AERIAL_LUT_WIDTH: f32 = 96.0;
export const AERIAL_LUT_HEIGHT: f32 = 64.0;
export const AERIAL_LUT_DEPTH: f32 = 32.0;
export const AERIAL_KM_PER_SLICE: f32 = 4.0;
/** AERIAL_KM_PER_SLICE * AERIAL_LUT_DEPTH: the far end of the aerial-perspective volume. */
export const AERIAL_MAX_DISTANCE: f32 = 128.0;

export struct Atmosphere {
  rayleighScattering: vec3f, rayleighScaleHeight: f32,
  mieScattering: vec3f, mieScaleHeight: f32,
  mieAbsorption: vec3f, mieG: f32,
  ozoneAbsorption: vec3f, ozoneCenter: f32,
  groundAlbedo: vec3f, ozoneWidth: f32,
  sunIlluminance: vec3f, groundRadius: f32,
  sunDirection: vec3f, atmosphereRadius: f32,
};

export struct Camera {
  position: vec3f, tanHalfFov: f32,
  forward: vec3f, aspect: f32,
  right: vec3f, sunAngularRadius: f32,
  up: vec3f, pixelAngle: f32,
};

/**
 * Values that are constant for a whole frame but were being recomputed per pixel or per sample.
 * Written by frame-constants.wgsl (one thread) from the same expressions the passes used, so results are identical.
 */
export const TERRAIN_TRANSMITTANCE_ENTRIES: u32 = 64u;

export struct FrameConstants {
  skyAmbient: vec3f, sunCosRadius: f32,
  groundBounce: vec3f, sunSinRadius: f32,
  sunHorizontal: vec3f, sunHorizontalLength: f32,
  beta: f32, zenithHorizonAngle: f32, sunSolidAngle: f32, sunTerrainVisibility: f32,
  /** Sun transmittance at terrain heights 0..TERRAIN_MAX_HEIGHT: the sun zenith angle is the same for all terrain. */
  terrainSunTransmittance: array<vec4f, 64>,
};

/**
 * The sun's shadow maps (terrain-sun-depth.wgsl): three orthographic cascades looking along the sun, centred on the
 * ground point under the camera axis and covering discs of `radii` km; the last one reaches the whole terrain.
 * Each `toShadowN` maps a position relative to that ground point to the cascade's clip space: xy in [-1, 1] across
 * the map, z in [0, 1] along the light, nearest first. `bias` per cascade is two texels of ground in depth units.
 * `fromShadow2` inverts the last cascade: the cloud shadow map (cloud-shadow.wgsl) is laid out in that space.
 */
export struct SunShadow { toShadow0: mat4x4f, toShadow1: mat4x4f, toShadow2: mat4x4f, fromShadow2: mat4x4f, radii: vec4f, bias: vec4f };
export const SUN_SHADOW_CASCADES: i32 = 3;

export fn sunShadowCascade(shadow: SunShadow, fromGround: vec3f) -> i32 {
  let distance = length(fromGround.xz);
  return select(select(2, 1, distance < shadow.radii.y), 0, distance < shadow.radii.x);
}

export fn sunShadowMatrix(shadow: SunShadow, cascade: i32) -> mat4x4f {
  if (cascade == 0) { return shadow.toShadow0; }
  if (cascade == 1) { return shadow.toShadow1; }
  return shadow.toShadow2;
}

fn compareCascade(cascade: i32, map0: texture_depth_2d, map1: texture_depth_2d, map2: texture_depth_2d, comparison: sampler_comparison, uv: vec2f, reference: f32) -> f32 {
  if (cascade == 0) { return textureSampleCompareLevel(map0, comparison, uv, reference); }
  if (cascade == 1) { return textureSampleCompareLevel(map1, comparison, uv, reference); }
  return textureSampleCompareLevel(map2, comparison, uv, reference);
}

/** Lit fraction of a point in one cascade: one hardware-filtered comparison, or five a texel apart when `soft`. */
fn cascadeLit(shadow: SunShadow, cascade: i32, map0: texture_depth_2d, map1: texture_depth_2d, map2: texture_depth_2d, comparison: sampler_comparison, fromGround: vec3f, biasScale: f32, soft: bool) -> f32 {
  let s = sunShadowMatrix(shadow, cascade) * vec4f(fromGround, 1.0);
  if (any(abs(s.xy) > vec2f(1.0)) || s.z > 1.0) { return 1.0; }
  let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
  let reference = s.z - shadow.bias[cascade] * biasScale;
  var lit = compareCascade(cascade, map0, map1, map2, comparison, uv, reference);
  if (soft) {
    let texel = 1.0 / vec2f(textureDimensions(map0));
    lit += compareCascade(cascade, map0, map1, map2, comparison, uv + vec2f(texel.x, 0.0), reference);
    lit += compareCascade(cascade, map0, map1, map2, comparison, uv - vec2f(texel.x, 0.0), reference);
    lit += compareCascade(cascade, map0, map1, map2, comparison, uv + vec2f(0.0, texel.y), reference);
    lit += compareCascade(cascade, map0, map1, map2, comparison, uv - vec2f(0.0, texel.y), reference);
    lit *= 0.2;
  }
  return lit;
}

/** 1 where the point sees the sun, 0 where the terrain is in the way; one comparison in the cascade the point falls in. */
export fn sunShadowSample(shadow: SunShadow, map0: texture_depth_2d, map1: texture_depth_2d, map2: texture_depth_2d, comparison: sampler_comparison, fromGround: vec3f, biasScale: f32) -> f32 {
  return cascadeLit(shadow, sunShadowCascade(shadow, fromGround), map0, map1, map2, comparison, fromGround, biasScale, false);
}

/**
 * Soft penumbra for a surface point, blended with the next cascade over the last tenth of the current one so the seam
 * does not show. Surfaces at a grazing angle to the light see their depth change by many texels across one map texel,
 * so the receiver moves out along its normal by up to 1.5 texels and the depth bias grows with the slope; a flat plain
 * under a 12 degree sun needs about ten times the bias of a slope facing the sun.
 */
export fn sunShadowSoft(shadow: SunShadow, map0: texture_depth_2d, map1: texture_depth_2d, map2: texture_depth_2d, comparison: sampler_comparison, fromGround: vec3f, normal: vec3f, sunDir: vec3f) -> f32 {
  let cascade = sunShadowCascade(shadow, fromGround);
  let ndl = saturate(dot(normal, sunDir));
  let texel = 2.0 * shadow.radii[cascade] / f32(textureDimensions(map0).x);
  let receiver = fromGround + normal * (texel * 1.5 * (1.0 - ndl));
  let biasScale = 1.0 + 2.0 * min(sqrt(1.0 - ndl * ndl) / max(ndl, 0.1), 5.0);
  var lit = cascadeLit(shadow, cascade, map0, map1, map2, comparison, receiver, biasScale, true);
  if (cascade < SUN_SHADOW_CASCADES - 1) {
    let radius = shadow.radii[cascade];
    let blend = smoothstep(0.9 * radius, radius, length(fromGround.xz));
    if (blend > 0.0) { lit = mix(lit, cascadeLit(shadow, cascade + 1, map0, map1, map2, comparison, receiver, biasScale, true), blend); }
  }
  return lit;
}

export struct Medium { scattering: vec3f, extinction: vec3f, mie: vec3f, rayleigh: vec3f };
export struct ScatteringResult { luminance: vec3f, transmittance: vec3f, multiScatAs1: vec3f };
export struct SkyViewParams { viewZenithCos: f32, lightViewCos: f32 };
export struct TransmittanceParams { viewHeight: f32, viewZenithCos: f32 };

export fn cameraRay(camera: Camera, ndc: vec2f) -> vec3f {
  return normalize(camera.forward + camera.right * (ndc.x * camera.tanHalfFov * camera.aspect) + camera.up * (ndc.y * camera.tanHalfFov));
}

/** Nearest non-negative intersection distance with a sphere centred at the origin, or -1. */
export fn raySphere(origin: vec3f, dir: vec3f, radius: f32) -> f32 {
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let delta = b * b - 4.0 * c;
  if (delta < 0.0) { return -1.0; }
  let root = sqrt(delta);
  let sol0 = (-b - root) * 0.5;
  let sol1 = (-b + root) * 0.5;
  if (sol0 < 0.0 && sol1 < 0.0) { return -1.0; }
  if (sol0 < 0.0) { return max(0.0, sol1); }
  if (sol1 < 0.0) { return max(0.0, sol0); }
  return max(0.0, min(sol0, sol1));
}

export fn sampleMedium(p: Atmosphere, position: vec3f) -> Medium {
  let altitude = max(0.0, length(position) - p.groundRadius);
  let rayleighDensity = exp(-altitude / p.rayleighScaleHeight);
  let mieDensity = exp(-altitude / p.mieScaleHeight);
  let ozoneDensity = max(0.0, 1.0 - abs(altitude - p.ozoneCenter) / p.ozoneWidth);
  var medium: Medium;
  medium.mie = p.mieScattering * mieDensity;
  medium.rayleigh = p.rayleighScattering * rayleighDensity;
  medium.scattering = medium.mie + medium.rayleigh;
  medium.extinction = medium.scattering + p.mieAbsorption * mieDensity + p.ozoneAbsorption * ozoneDensity;
  return medium;
}

export fn rayleighPhase(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

/** Cornette-Shanks phase; cosTheta = dot(viewDir, sunDir) so forward scattering peaks looking at the sun. */
export fn miePhase(g: f32, cosTheta: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta)) / ((2.0 + g2) * denom * sqrt(denom));
}

export fn fromUnitToSubUvs(u: f32, resolution: f32) -> f32 { return (u + 0.5 / resolution) * (resolution / (resolution + 1.0)); }
export fn fromSubUvsToUnit(u: f32, resolution: f32) -> f32 { return (u - 0.5 / resolution) * (resolution / (resolution - 1.0)); }

/** Bruneton's transmittance parametrisation: u = distance to the top boundary, v = altitude. */
export fn transmittanceUv(p: Atmosphere, viewHeight: f32, viewZenithCos: f32) -> vec2f {
  let h = sqrt(max(0.0, p.atmosphereRadius * p.atmosphereRadius - p.groundRadius * p.groundRadius));
  let rho = sqrt(max(0.0, viewHeight * viewHeight - p.groundRadius * p.groundRadius));
  let discriminant = viewHeight * viewHeight * (viewZenithCos * viewZenithCos - 1.0) + p.atmosphereRadius * p.atmosphereRadius;
  let d = max(0.0, -viewHeight * viewZenithCos + sqrt(max(0.0, discriminant)));
  let dMin = p.atmosphereRadius - viewHeight;
  let dMax = rho + h;
  return vec2f((d - dMin) / (dMax - dMin), rho / h);
}

export fn transmittanceParams(p: Atmosphere, uv: vec2f) -> TransmittanceParams {
  let h = sqrt(p.atmosphereRadius * p.atmosphereRadius - p.groundRadius * p.groundRadius);
  let rho = h * uv.y;
  let viewHeight = sqrt(rho * rho + p.groundRadius * p.groundRadius);
  let dMin = p.atmosphereRadius - viewHeight;
  let dMax = rho + h;
  let d = dMin + uv.x * (dMax - dMin);
  var viewZenithCos = 1.0;
  if (d > 0.0) { viewZenithCos = (h * h - rho * rho - d * d) / (2.0 * viewHeight * d); }
  return TransmittanceParams(viewHeight, clamp(viewZenithCos, -1.0, 1.0));
}

export fn sampleTransmittance(p: Atmosphere, lut: texture_2d<f32>, lutSampler: sampler, viewHeight: f32, viewZenithCos: f32) -> vec3f {
  return textureSampleLevel(lut, lutSampler, transmittanceUv(p, viewHeight, viewZenithCos), 0.0).rgb;
}

export fn sampleMultiScatter(p: Atmosphere, lut: texture_2d<f32>, lutSampler: sampler, viewHeight: f32, sunZenithCos: f32) -> vec3f {
  let uv = saturate(vec2f(sunZenithCos * 0.5 + 0.5, (viewHeight - p.groundRadius) / (p.atmosphereRadius - p.groundRadius)));
  let sub = vec2f(fromUnitToSubUvs(uv.x, MULTISCATTER_LUT_SIZE), fromUnitToSubUvs(uv.y, MULTISCATTER_LUT_SIZE));
  return textureSampleLevel(lut, lutSampler, sub, 0.0).rgb;
}

/** Sky-view LUT mapping with a non-linear horizon fold so the horizon band keeps most texels. */
export fn skyViewUv(p: Atmosphere, viewHeight: f32, viewZenithCos: f32, lightViewCos: f32, intersectGround: bool) -> vec2f {
  let vHorizon = sqrt(max(0.0, viewHeight * viewHeight - p.groundRadius * p.groundRadius));
  let beta = acos(clamp(vHorizon / viewHeight, -1.0, 1.0));
  let zenithHorizonAngle = PI - beta;
  let viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));
  var v = 0.0;
  if (!intersectGround) {
    let coord = 1.0 - sqrt(saturate(1.0 - viewZenith / zenithHorizonAngle));
    v = coord * 0.5;
  } else {
    let coord = sqrt(saturate((viewZenith - zenithHorizonAngle) / beta));
    v = coord * 0.5 + 0.5;
  }
  let u = sqrt(saturate(-lightViewCos * 0.5 + 0.5));
  return vec2f(fromUnitToSubUvs(u, SKY_VIEW_LUT_WIDTH), fromUnitToSubUvs(v, SKY_VIEW_LUT_HEIGHT));
}

/** Same mapping as skyViewUv with the camera-height terms taken from FrameConstants. */
export fn skyViewUvFast(f: FrameConstants, viewZenithCos: f32, lightViewCos: f32, intersectGround: bool) -> vec2f {
  let viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));
  var v = 0.0;
  if (!intersectGround) {
    let coord = 1.0 - sqrt(saturate(1.0 - viewZenith / f.zenithHorizonAngle));
    v = coord * 0.5;
  } else {
    let coord = sqrt(saturate((viewZenith - f.zenithHorizonAngle) / f.beta));
    v = coord * 0.5 + 0.5;
  }
  let u = sqrt(saturate(-lightViewCos * 0.5 + 0.5));
  return vec2f(fromUnitToSubUvs(u, SKY_VIEW_LUT_WIDTH), fromUnitToSubUvs(v, SKY_VIEW_LUT_HEIGHT));
}

export fn skyViewParams(p: Atmosphere, viewHeight: f32, uvIn: vec2f) -> SkyViewParams {
  let uv = vec2f(fromSubUvsToUnit(uvIn.x, SKY_VIEW_LUT_WIDTH), fromSubUvsToUnit(uvIn.y, SKY_VIEW_LUT_HEIGHT));
  let vHorizon = sqrt(max(0.0, viewHeight * viewHeight - p.groundRadius * p.groundRadius));
  let beta = acos(clamp(vHorizon / viewHeight, -1.0, 1.0));
  let zenithHorizonAngle = PI - beta;
  var viewZenithCos = 0.0;
  if (uv.y < 0.5) {
    var coord = 1.0 - 2.0 * uv.y;
    coord = 1.0 - coord * coord;
    viewZenithCos = cos(zenithHorizonAngle * coord);
  } else {
    var coord = uv.y * 2.0 - 1.0;
    coord = coord * coord;
    viewZenithCos = cos(zenithHorizonAngle + beta * coord);
  }
  let lightViewCos = -(uv.x * uv.x * 2.0 - 1.0);
  return SkyViewParams(viewZenithCos, lightViewCos);
}

/** Single pass of the Hillaire integrator. Used by every LUT and by the multi-scatter bootstrap. */
export fn integrateScattering(
  p: Atmosphere, origin: vec3f, dir: vec3f, sunDir: vec3f, tMaxMax: f32, sampleCount: f32,
  mieRayleighPhase: bool, includeGround: bool, useMultiScatter: bool,
  transmittanceLut: texture_2d<f32>, multiScatterLut: texture_2d<f32>, lutSampler: sampler,
) -> ScatteringResult {
  var result = ScatteringResult(vec3f(0.0), vec3f(1.0), vec3f(0.0));
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
  let hitsGround = tBottom >= 0.0 && tMax >= tBottom;

  let cosTheta = dot(dir, sunDir);
  let phaseMie = miePhase(p.mieG, cosTheta);
  let phaseRayleigh = rayleighPhase(cosTheta);
  let uniformPhase = 1.0 / (4.0 * PI);

  let dt = tMax / sampleCount;
  var throughput = vec3f(1.0);
  var luminance = vec3f(0.0);
  var multiScatAs1 = vec3f(0.0);
  for (var i = 0.0; i < sampleCount; i += 1.0) {
    let t = (i + 0.3) * dt;
    let position = origin + t * dir;
    let medium = sampleMedium(p, position);
    let viewHeight = length(position);
    let up = position / viewHeight;
    let sunZenithCos = dot(sunDir, up);
    let sunTransmittance = sampleTransmittance(p, transmittanceLut, lutSampler, viewHeight, sunZenithCos);
    let earthShadow = select(1.0, 0.0, raySphere(position + up * PLANET_RADIUS_OFFSET, sunDir, p.groundRadius) >= 0.0);
    var multiScatter = vec3f(0.0);
    if (useMultiScatter) { multiScatter = sampleMultiScatter(p, multiScatterLut, lutSampler, viewHeight, sunZenithCos); }
    var phaseTimesScattering = medium.scattering * uniformPhase;
    if (mieRayleighPhase) { phaseTimesScattering = medium.mie * phaseMie + medium.rayleigh * phaseRayleigh; }
    let scattered = p.sunIlluminance * (earthShadow * sunTransmittance * phaseTimesScattering + multiScatter * medium.scattering);
    let extinction = max(medium.extinction, vec3f(1e-7));
    let stepTransmittance = exp(-extinction * dt);
    luminance += throughput * (scattered - scattered * stepTransmittance) / extinction;
    multiScatAs1 += throughput * (medium.scattering - medium.scattering * stepTransmittance) / extinction;
    throughput *= stepTransmittance;
  }

  if (includeGround && hitsGround) {
    let position = origin + tBottom * dir;
    let up = normalize(position);
    let sunZenithCos = dot(sunDir, up);
    let sunTransmittance = sampleTransmittance(p, transmittanceLut, lutSampler, p.groundRadius, sunZenithCos);
    luminance += p.sunIlluminance * sunTransmittance * throughput * max(sunZenithCos, 0.0) * p.groundAlbedo / PI;
  }

  result.luminance = luminance;
  result.transmittance = throughput;
  result.multiScatAs1 = multiScatAs1;
  return result;
}

export fn meanTransmittance(t: vec3f) -> f32 { return dot(t, vec3f(1.0 / 3.0)); }

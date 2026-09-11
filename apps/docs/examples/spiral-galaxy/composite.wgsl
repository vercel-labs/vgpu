// Final pass: scene + bloom, a screen-space lens flare anchored on the hero
// stars the compute pass published, dirty-glass warp and grain, then ACES tone
// mapping and the sRGB transfer for the canvas.

import { linearToSrgb3, luminance, tonemapAces } from "@vgpu/wgsl-std/color";

struct Params {
  aspect: f32,
  bloomIntensity: f32,
  exposure: f32,
  flareEnabled: f32,
  intensity: f32,
  halo: f32,
  streaks: f32,
  streakLength: f32,
  verticalStreaks: f32,
  ghosts: f32,
  secondary: f32,
  dirtEnabled: f32,
  distortion: f32,
  grain: f32,
  procedural: f32,
  textureDirt: f32,
  dirtAspect: f32,
  dirtRotation: f32,
  secondaryCount: u32,
  coreLayer: u32,
  dirtOffset: vec2f,
  pad: vec2f,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloomNear: texture_2d<f32>;
@group(0) @binding(2) var bloomFar: texture_2d<f32>;
@group(0) @binding(3) var dirt: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<storage, read> flares: array<vec4f>;
@group(0) @binding(6) var<uniform> params: Params;

const FLARE_TINT = vec3f(0.956, 0.956, 0.956);

fn sceneColor(uv: vec2f) -> vec3f {
  let at = clamp(uv, vec2f(0.001), vec2f(0.999));
  let base = textureSampleLevel(scene, samp, at, 0.0).rgb;
  let bloom = 0.4 * textureSampleLevel(bloomNear, samp, at, 0.0).rgb
    + 0.6 * textureSampleLevel(bloomFar, samp, at, 0.0).rgb;
  return base + bloom * params.bloomIntensity;
}

fn hash(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn softDisc(point: vec2f, radius: f32, softness: f32) -> f32 {
  return 1.0 - smoothstep(radius - softness, radius + softness, length(point));
}

fn softRing(point: vec2f, radius: f32, width: f32) -> f32 {
  let d = abs(length(point) - radius);
  return 1.0 - smoothstep(width, width * 2.0, d);
}

fn aspectCorrect(point: vec2f) -> vec2f {
  return vec2f(point.x * params.aspect, point.y);
}

fn coverTextureUv(uv: vec2f, viewportAspect: f32, textureAspect: f32) -> vec2f {
  var centered = uv - 0.5;
  if (viewportAspect > textureAspect) {
    centered.y *= textureAspect / viewportAspect;
  } else {
    centered.x *= viewportAspect / textureAspect;
  }
  return centered + 0.5;
}

fn streakWindow(distance: f32) -> f32 {
  let window = 1.0 - smoothstep(params.streakLength * 0.72, params.streakLength, distance);
  return mix(window, 1.0, step(0.99, params.streakLength));
}

// The stroke heroes already have a sharp bloomed core; their optics add only a
// soft halo and restrained streaks.
fn secondaryFlare(center: vec2f, uv: vec2f) -> f32 {
  let point = aspectCorrect(uv - center);
  let distanceToSource = length(point);
  let nearHalo = exp(-distanceToSource * distanceToSource * 520.0) * 0.1;
  let halo = exp(-distanceToSource * 17.0) * 0.055;
  let horizontalStreak = exp(-abs(point.y) * 360.0) * exp(-abs(point.x) * 10.0) * streakWindow(abs(point.x)) * 0.24;
  let verticalStreak = exp(-abs(point.x) * 360.0) * exp(-abs(point.y) * 10.0) * streakWindow(abs(point.y)) * 0.24 * params.verticalStreaks;
  return nearHalo + halo + horizontalStreak + verticalStreak;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = sceneColor(uv);
  let primary = flares[params.coreLayer];
  let center = primary.xy;
  let visibility = primary.z;
  let source = aspectCorrect(uv - center);
  let sourceDistance = length(source);

  let core = exp(-sourceDistance * sourceDistance * 480.0) * 0.18;
  var halo = exp(-sourceDistance * 11.5) * params.halo;
  halo += softRing(source, 0.105, 0.006) * 0.05 * params.halo;

  let horizontalWindow = streakWindow(abs(source.x));
  let verticalWindow = streakWindow(abs(source.y));
  let horizontalStreak = exp(-abs(source.y) * 310.0) * exp(-abs(source.x) * 7.5) * horizontalWindow;
  let softHorizontalStreak = exp(-abs(source.y) * 78.0) * exp(-abs(source.x) * 5.2) * horizontalWindow * 0.16;
  let verticalStreak = exp(-abs(source.x) * 310.0) * exp(-abs(source.y) * 7.5) * verticalWindow;
  let softVerticalStreak = exp(-abs(source.x) * 78.0) * exp(-abs(source.y) * 5.2) * verticalWindow * 0.16;
  let streak = (horizontalStreak + softHorizontalStreak + (verticalStreak + softVerticalStreak) * params.verticalStreaks) * params.streaks;

  // Ghosts mirror the source through the optical axis.
  let opticalAxis = vec2f(0.5) - center;
  let ghostA = aspectCorrect(uv - (center + opticalAxis * 0.82));
  let ghostB = aspectCorrect(uv - (center + opticalAxis * 1.38));
  let ghostC = aspectCorrect(uv - (center + opticalAxis * 1.82));
  var ghosts = softDisc(ghostA, 0.016, 0.014) * 0.18;
  ghosts += softRing(ghostB, 0.046, 0.006) * 0.11;
  ghosts += softDisc(ghostC, 0.025, 0.02) * 0.08;
  ghosts *= params.ghosts;

  let flare = (core + halo + streak + ghosts) * params.intensity;
  var secondary = 0.0;
  var secondaryDirtHalo = 0.0;
  for (var i = 0u; i < params.secondaryCount; i++) {
    let source2 = flares[i];
    secondary += secondaryFlare(source2.xy, uv) * source2.z;
    secondaryDirtHalo += exp(-length(aspectCorrect(uv - source2.xy)) * 10.0) * source2.z;
  }
  secondary *= params.intensity * params.secondary;
  let flareColor = FLARE_TINT * (flare * visibility + secondary) * params.flareEnabled;

  var optical = base + flareColor;
  let baseLuminance = luminance(base);
  let reveal = smoothstep(0.025, 0.72, baseLuminance);

  // Dirty glass: the baked dirt map drifts with the rotation.
  var driftingUv = uv - 0.5;
  let rc = cos(params.dirtRotation);
  let rs = sin(params.dirtRotation);
  driftingUv = mat2x2f(rc, -rs, rs, rc) * driftingUv + params.dirtOffset;
  let dirtUv = clamp(coverTextureUv(driftingUv + 0.5, params.aspect, params.dirtAspect), vec2f(0.001), vec2f(0.999));
  let dirtLuminance = textureSampleLevel(dirt, samp, dirtUv, 0.0).r;
  let photographicDirt = smoothstep(0.1, 0.72, dirtLuminance);
  let proceduralDirt = smoothstep(0.025, 0.32, dirtLuminance);
  let textureAmount = params.textureDirt * params.dirtEnabled;
  let proceduralAmount = params.procedural * params.dirtEnabled;
  let dirtMask = clamp(photographicDirt * textureAmount + proceduralDirt * proceduralAmount, 0.0, 1.0);
  let dirtVariation = clamp((photographicDirt - 0.4) * textureAmount + (proceduralDirt - 0.4) * proceduralAmount, -0.7, 0.9);
  let dirtReveal = smoothstep(0.008, 0.2, baseLuminance) * (1.0 - smoothstep(0.9, 3.0, baseLuminance) * 0.68);
  let primaryDirtHalo = exp(-sourceDistance * 6.5) * visibility;
  let dirtHalo = (primaryDirtHalo + secondaryDirtHalo * params.secondary) * params.intensity * params.flareEnabled;

  // Refraction through the dirt: a warp field from two rotated dirt samples.
  let warpUvX = dirtUv * vec2f(0.72, 0.78) + vec2f(0.17, 0.08);
  let warpUvY = vec2f(1.0 - dirtUv.y, dirtUv.x) * vec2f(0.74, 0.7) + vec2f(0.12, 0.16);
  let warpSampleX = textureSampleLevel(dirt, samp, warpUvX, 0.0).r;
  let warpSampleY = textureSampleLevel(dirt, samp, warpUvY, 0.0).r;
  let warpField = clamp((vec2f(warpSampleX, warpSampleY) - dirtLuminance) * 6.0, vec2f(-0.5), vec2f(0.5));
  let warp = warpField * vec2f(1.0 / max(params.aspect, 0.001), 1.0) * params.distortion * 0.004;
  let warpedBase = sceneColor(uv + warp);
  optical += (warpedBase - base) * reveal * params.dirtEnabled * 0.55;
  optical *= 1.0 + dirtVariation * dirtReveal * 0.82;
  optical += vec3f(max(dirtVariation, 0.0)) * dirtReveal * (0.022 + min(baseLuminance, 0.8) * 0.055);
  optical += FLARE_TINT * dirtHalo * dirtMask * 0.14;

  let grain = hash(floor(uv * vec2f(1536.0, 1024.0)));
  optical += vec3f((grain - 0.5) * params.grain) * (0.18 + reveal * 0.82) * params.dirtEnabled;

  let mapped = tonemapAces(max(optical, vec3f(0.0)) * params.exposure);
  return vec4f(linearToSrgb3(mapped), 1.0);
}

// Per-frame shading: decode the bake, shade stars and disk layers, then composite them.

import { GBufferSample, GBufferLayers, decodeGBuffer, sampleAtRadius, ISCO, PI_CONST, TAU } from "./gbuffer.wgsl";
import { DiskLook, DiskSample, shadeDisk, SHEAR_PERIOD } from "./disk.wgsl";
import { StarLook, shadeStars } from "./stars.wgsl";

struct Shade {
  resolution: vec2f,
  time: f32,
  diskOuter: f32,
  sceneYaw: f32,
  centerFade: f32,
}

const DISK_GAIN: f32 = 1.35;

fn centeredCopyFade(uvY: f32) -> f32 {
  let distanceFromCenter = abs(uvY - 0.5);
  return pow(smoothstep(0.08, 0.38, distanceFromCenter), 2.2);
}

@group(0) @binding(0) var<uniform> shade: Shade;
@group(0) @binding(1) var gHit1: texture_2d<f32>;
@group(0) @binding(2) var gHit2: texture_2d<f32>;
@group(0) @binding(3) var gSky: texture_2d<f32>;
@group(0) @binding(4) var gView: texture_2d<f32>;
@group(0) @binding(5) var<uniform> disk: DiskLook;
@group(0) @binding(6) var<uniform> stars: StarLook;

@group(0) @binding(7) var noiseVolume: texture_3d<f32>;
@group(0) @binding(8) var noiseSampler: sampler;

@group(0) @binding(9) var gAa: texture_2d<f32>;

@group(0) @binding(10) var gAaGeom: texture_2d<f32>;

fn diskFootprintAxes(g: GBufferSample) -> vec2f {
  let angular = max(disk.stretch, 0.05);
  let noiseAngle = g.diskPolar.y
    - min(shade.time, SHEAR_PERIOD * 0.5) * (disk.speed * 0.55 / pow(g.diskPolar.x, 1.5));
  let noiseCoords = vec3f(
    cos(noiseAngle) * angular,
    sin(noiseAngle) * angular,
    g.diskPolar.x * disk.detail,
  );
  return vec2f(
    max(fwidth(noiseCoords.x), fwidth(noiseCoords.y)),
    fwidth(noiseCoords.z),
  );
}

fn diskFootprint(axes: vec2f) -> f32 {
  return min(max(axes.x, axes.y), 4.0);
}

fn rotateY(v: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

fn wrapAngle(angle: f32) -> f32 {
  return angle - TAU * floor((angle + PI_CONST) / TAU);
}

fn rotateSample(g: GBufferSample, angle: f32) -> GBufferSample {
  var rotated = g;
  rotated.position = rotateY(g.position, angle);
  rotated.viewDirection = rotateY(g.viewDirection, angle);
  rotated.rayDirection = rotateY(g.rayDirection, angle);
  let azimuth = wrapAngle(g.diskPolar.y - angle);
  rotated.diskPolar = vec2f(g.diskPolar.x, azimuth);
  rotated.diskUv = vec2f(g.diskUv.x, (azimuth + PI_CONST) / TAU);
  return rotated;
}

fn rotateLayers(layers: GBufferLayers, angle: f32) -> GBufferLayers {
  var rotated: GBufferLayers;
  rotated.front = rotateSample(layers.front, angle);
  rotated.back = rotateSample(layers.back, angle);
  return rotated;
}

const AA_TAPS: i32 = 6;

const AA_SPAN_MIN: f32 = 0.15;

fn shadeFront(g: GBufferSample, footprint: f32, angularFootprint: f32) -> DiskSample {
  let annulus = max(shade.diskOuter - ISCO, 0.001);
  let spanWorld = g.span * annulus;
  if (g.span <= AA_SPAN_MIN) {
    return shadeDisk(g, disk, shade.time, footprint, noiseVolume, noiseSampler);
  }

  let tapFootprint = min(max(angularFootprint, max(disk.detail, 0.05) * (spanWorld / f32(AA_TAPS))), 4.0);
  let step = spanWorld / f32(AA_TAPS);
  let start = g.diskPolar.x - spanWorld * 0.5;

  var sumEmission = vec3f(0.0);
  var sumAlpha = 0.0;
  var taps = 0.0;
  for (var i = 0; i < AA_TAPS; i++) {
    let radius = start + (f32(i) + 0.5) * step;
    if (radius < ISCO || radius > shade.diskOuter) {
      continue;
    }
    let tap = shadeDisk(
      sampleAtRadius(g, radius, shade.diskOuter), disk, shade.time,
      tapFootprint, noiseVolume, noiseSampler,
    );
    sumEmission += tap.color * tap.alpha;
    sumAlpha += tap.alpha;
    taps += 1.0;
  }
  if (taps < 0.5) {
    return shadeDisk(g, disk, shade.time, footprint, noiseVolume, noiseSampler);
  }

  var sample: DiskSample;
  let meanAlpha = sumAlpha / taps;
  sample.alpha = meanAlpha;
  sample.color = select(vec3f(0.0), (sumEmission / taps) / max(meanAlpha, 1e-6), meanAlpha > 1e-6);
  return sample;
}

fn emptyDiskSample() -> DiskSample {
  var sample: DiskSample;
  sample.color = vec3f(0.0);
  sample.alpha = 0.0;
  return sample;
}

fn compositeDisk(under: vec3f, sample: DiskSample) -> vec3f {
  return sample.color * sample.alpha * DISK_GAIN + under * (1.0 - sample.alpha);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dimensions = vec2f(textureDimensions(gHit1, 0));
  let texel = vec2i(clamp(uv * dimensions, vec2f(0.0), dimensions - vec2f(1.0)));

  let aa = textureLoad(gAa, texel, 0).xy;
  let aaGeom = textureLoad(gAaGeom, texel, 0);

  let baked = decodeGBuffer(
    textureLoad(gHit1, texel, 0).xy,
    textureLoad(gHit2, texel, 0).xy,
    textureLoad(gSky, texel, 0),
    textureLoad(gView, texel, 0),
    shade.diskOuter,
    aa,
    aaGeom,
  );

  let frontAxes = diskFootprintAxes(baked.front);
  let backAxes = diskFootprintAxes(baked.back);
  let frontFootprint = diskFootprint(frontAxes);
  let backFootprint = diskFootprint(backAxes);

  let bakedRayDirection = baked.front.rayDirection;
  let skyDdx = dpdx(bakedRayDirection);
  let skyDdy = dpdy(bakedRayDirection);

  let layers = rotateLayers(baked, -shade.sceneYaw);
  let g = layers.front;
  let skyDdxRotated = rotateY(skyDdx, -shade.sceneYaw);
  let skyDdyRotated = rotateY(skyDdy, -shade.sceneYaw);

  var background = vec3f(0.0);
  if (!g.isBlackHole && g.escaped) {
    background = shadeStars(g.rayDirection, stars, shade.time, skyDdxRotated, skyDdyRotated);
  }

  var backSample = emptyDiskSample();
  var frontSample = emptyDiskSample();
  if (layers.back.isHit) {
    backSample = shadeDisk(layers.back, disk, shade.time, backFootprint, noiseVolume, noiseSampler);
  }
  if (layers.front.isHit) {
    frontSample = shadeFront(layers.front, frontFootprint, frontAxes.x);
    frontSample.alpha *= layers.front.coverage;
  }

  var color = background;
  color = compositeDisk(color, backSample);
  color = compositeDisk(color, frontSample);

  let centerMask = mix(
    1.0,
    centeredCopyFade(uv.y),
    clamp(shade.centerFade, 0.0, 1.0),
  );
  let heroFade = centerMask;

  color *= heroFade;

  return vec4f(color, 1.0);
}

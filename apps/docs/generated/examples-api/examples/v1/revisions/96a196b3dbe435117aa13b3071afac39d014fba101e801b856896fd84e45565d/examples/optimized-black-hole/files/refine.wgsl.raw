// One-shot photon-ring refinement: measure sub-pixel coverage and synthesize missed crossings.

import { HORIZON, ISCO, cameraRay, encodeDirection, escapeRadiusFor, traceRay } from "./geodesic.wgsl";

struct Refine {
  resolution: vec2f,
  yaw: f32,
  pitch: f32,
  orbitRadius: f32,
  diskOuter: f32,
  fov: f32,
  centerX: f32,
  centerY: f32,
  roll: f32,
}

@group(0) @binding(0) var<uniform> refine: Refine;

@group(0) @binding(1) var gHit1: texture_2d<f32>;

@group(0) @binding(2) var gSky: texture_2d<f32>;

const SUB_STEPS: i32 = 4;

const MASK_RADIUS: i32 = 2;

const GRADIENT_LIMIT: f32 = 0.12;

const B_CRIT: f32 = 2.59807621;

const CRITICAL_BAND: f32 = 0.06;

fn isHitAt(plane: vec2f) -> bool {
  return length(plane) > ISCO * 0.5;
}

struct RefineOut {
  @location(0) coverage: vec2f,
  @location(1) geometry: vec4f,
}

@fragment fn fs_main(@location(0) uv: vec2f) -> RefineOut {
  let dimensions = vec2i(textureDimensions(gHit1, 0));
  let texel = vec2i(clamp(uv * refine.resolution, vec2f(0.0), refine.resolution - vec2f(1.0)));
  let annulus = max(refine.diskOuter - ISCO, 0.001);

  let centerPlane = textureLoad(gHit1, texel, 0).xy;
  let centerHit = isHitAt(centerPlane);
  let centerHole = (i32(textureLoad(gSky, texel, 0).w + 0.5) & 1) != 0;
  let centerRadiusNorm = clamp((length(centerPlane) - ISCO) / annulus, 0.0, 1.0);

  let centerRay = cameraRay(
    uv,
    refine.resolution,
    refine.yaw,
    refine.pitch,
    refine.orbitRadius,
    refine.fov,
    refine.centerX,
    refine.centerY,
    refine.roll,
  );
  let impactParameter = length(cross(centerRay.position, centerRay.velocity));

  var boundary = abs(impactParameter - B_CRIT) < CRITICAL_BAND * HORIZON;
  for (var dy = -MASK_RADIUS; dy <= MASK_RADIUS; dy++) {
    for (var dx = -MASK_RADIUS; dx <= MASK_RADIUS; dx++) {
      let neighbor = clamp(texel + vec2i(dx, dy), vec2i(0), dimensions - vec2i(1));
      let plane = textureLoad(gHit1, neighbor, 0).xy;
      let hit = isHitAt(plane);
      let hole = (i32(textureLoad(gSky, neighbor, 0).w + 0.5) & 1) != 0;
      if (hit != centerHit || hole != centerHole) {
        boundary = true;
      }
      if (hit && centerHit) {
        let radiusNorm = clamp((length(plane) - ISCO) / annulus, 0.0, 1.0);
        if (abs(radiusNorm - centerRadiusNorm) > GRADIENT_LIMIT) {
          boundary = true;
        }
      }
    }
  }

  if (!boundary) {
    return RefineOut(vec2f(select(0.0, 1.0, centerHit), 0.0), vec4f(0.0));
  }

  let escapeRadius = escapeRadiusFor(refine.orbitRadius);
  var hits = 0.0;
  var minRadius = 1e9;
  var maxRadius = -1e9;
  var bestPlane = vec2f(0.0);
  var bestDirection = vec2f(0.0);
  var bestRadius = 0.0;
  var bestDistance = 1e9;
  for (var sy = 0; sy < SUB_STEPS; sy++) {
    for (var sx = 0; sx < SUB_STEPS; sx++) {
      let offset = (vec2f(f32(sx), f32(sy)) + vec2f(0.5)) / f32(SUB_STEPS);
      let subUv = (vec2f(texel) + offset) / refine.resolution;
      let ray = cameraRay(
        subUv,
        refine.resolution,
        refine.yaw,
        refine.pitch,
        refine.orbitRadius,
        refine.fov,
        refine.centerX,
        refine.centerY,
        refine.roll,
      );
      let traced = traceRay(ray.position, ray.velocity, refine.diskOuter, escapeRadius);
      if (traced.hitCount > 0) {
        let radius = length(traced.hit1Plane);
        hits += 1.0;
        minRadius = min(minRadius, radius);
        maxRadius = max(maxRadius, radius);
        let distance = length(offset - vec2f(0.5));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPlane = traced.hit1Plane;
          bestDirection = traced.hit1Direction;
          bestRadius = radius;
        }
      }
    }
  }

  let coverage = hits / f32(SUB_STEPS * SUB_STEPS);
  if (hits < 0.5) {
    return RefineOut(vec2f(0.0, 0.0), vec4f(0.0));
  }

  var r0 = length(centerPlane);
  var span = 0.0;
  var geometry = vec4f(0.0);
  if (centerHit) {
    span = 2.0 * max(abs(maxRadius - r0), abs(r0 - minRadius));
  } else {
    r0 = 0.5 * (minRadius + maxRadius);
    span = maxRadius - minRadius;
    geometry = vec4f(bestPlane * (r0 / max(bestRadius, ISCO)), bestDirection);
  }
  return RefineOut(vec2f(coverage, clamp(span / annulus, 0.0, 1.0)), geometry);
}

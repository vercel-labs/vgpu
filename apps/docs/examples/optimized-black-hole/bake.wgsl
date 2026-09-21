// One-shot geodesic bake: store two disk crossings, the lensed sky, and view directions.

import { TraceResult, cameraRay, escapeRadiusFor, traceRay } from "./geodesic.wgsl";

struct Bake {
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

@group(0) @binding(0) var<uniform> bake: Bake;

const FLAG_HOLE: f32 = 1.0;

const FLAG_ESCAPED: f32 = 2.0;

struct GBuffer {
  @location(0) hit1: vec2f,
  @location(1) hit2: vec2f,
  @location(2) sky: vec4f,
  @location(3) view: vec4f,
}

@fragment fn fs_main(@location(0) uv: vec2f) -> GBuffer {
  let ray = cameraRay(
    uv,
    bake.resolution,
    bake.yaw,
    bake.pitch,
    bake.orbitRadius,
    bake.fov,
    bake.centerX,
    bake.centerY,
    bake.roll,
  );
  var traced = traceRay(ray.position, ray.velocity, bake.diskOuter, escapeRadiusFor(bake.orbitRadius));

  if (traced.swallowed < 0.5 && traced.escaped < 0.5) {
    traced.swallowed = 1.0;
  }

  return GBuffer(
    traced.hit1Plane,
    traced.hit2Plane,
    vec4f(traced.finalVelocity, traced.swallowed * FLAG_HOLE + traced.escaped * FLAG_ESCAPED),
    vec4f(traced.hit1Direction, traced.hit2Direction),
  );
}

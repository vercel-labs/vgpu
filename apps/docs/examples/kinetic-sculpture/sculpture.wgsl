import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import { Studio, display, keyShadow, shade } from "./studio.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) tint: vec3f,
  @location(8) finish: vec2f,
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) tint: vec3f,
  @location(3) finish: vec2f,
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  // The bound node's world matrix arrives as four columns; nonuniform scales (rods, discs,
  // ellipsoids) are corrected by transformNormal's inverse-transpose.
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let position = transformPosition(world, input.position);
  var out: VertexOut;
  out.clip = studio.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = transformNormal(world, input.normal);
  out.tint = input.tint;
  out.finish = input.finish;
  return out;
}

@fragment
fn fs_main(input: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var normal = normalize(input.worldNormal);
  if (!front) {
    normal = -normal;
  }
  let shadow = keyShadow(shadowMap, shadowSampler, studio, input.worldPosition, normal);
  let radiance = shade(studio, input.tint, input.finish.x, input.finish.y, input.worldPosition, normal, shadow);
  return vec4f(display(radiance, studio.exposure), 1.0);
}

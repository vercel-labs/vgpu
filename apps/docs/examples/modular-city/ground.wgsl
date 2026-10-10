import { saturate } from "@vgpu/wgsl-std/math";
import { Camera, Scene, finish, shade, sunShadow } from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

// Keep in sync with layout.ts.
const TILE_SIZE: f32 = 14.0;
const PITCH: f32 = 17.2;
const ROAD_HALF: f32 = 1.6;
const BOARD_HALF: f32 = 36.0;
const BASE_HALF: f32 = 38.4;

struct GroundVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
}

@vertex
fn vs_main(@location(0) position: vec3f) -> GroundVarying {
  var output: GroundVarying;
  output.worldPosition = position;
  output.clip = camera.viewProjection * vec4f(position, 1.0);
  return output;
}

fn band(distance: f32, half: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(half - footprint, half + footprint, distance);
}

@fragment
fn fs_main(input: GroundVarying) -> @location(0) vec4f {
  let p = input.worldPosition.xz;
  let footprint = max(fwidth(p.x), fwidth(p.y)) * 0.75;
  let edge = max(abs(p.x), abs(p.y));

  // Road centerlines run on multiples of the tile pitch.
  let lane = abs(p - round(p / PITCH) * PITCH);
  let tileOffset = abs(p - (floor(p / PITCH) + 0.5) * PITCH);
  let onRoadX = lane.x < ROAD_HALF;
  let onRoadZ = lane.y < ROAD_HALF;
  let intersection = onRoadX && onRoadZ;

  var albedo = vec3f(0.24, 0.235, 0.23);
  // Asphalt grain from a cheap integer hash of the 10 cm cell.
  let cell = vec2u(vec2i(floor(p * 10.0)) + vec2i(4096));
  let grain = f32(((cell.x * 73856093u) ^ (cell.y * 19349663u)) % 1024u) / 1024.0;
  albedo *= 0.94 + 0.08 * grain;

  // Dashed centerlines and zebra crosswalks next to every intersection.
  let dashX = band(lane.x, 0.06, footprint) * step(0.5, fract(p.y / 1.4)) * select(1.0, 0.0, onRoadZ);
  let dashZ = band(lane.y, 0.06, footprint) * step(0.5, fract(p.x / 1.4)) * select(1.0, 0.0, onRoadX);
  let crossX = select(0.0, 1.0, onRoadX && !onRoadZ && tileOffset.y > TILE_SIZE * 0.5 - 0.9 && tileOffset.y < TILE_SIZE * 0.5 - 0.15);
  let crossZ = select(0.0, 1.0, onRoadZ && !onRoadX && tileOffset.x > TILE_SIZE * 0.5 - 0.9 && tileOffset.x < TILE_SIZE * 0.5 - 0.15);
  let zebraX = band(abs(fract(p.x / 0.4) - 0.5) * 0.4, 0.1, footprint) * crossX;
  let zebraZ = band(abs(fract(p.y / 0.4) - 0.5) * 0.4, 0.1, footprint) * crossZ;
  let paint = saturate(dashX + dashZ) * select(1.0, 0.0, intersection);
  albedo = mix(albedo, vec3f(0.92, 0.8, 0.45), paint * 0.85);
  albedo = mix(albedo, vec3f(0.9, 0.89, 0.85), saturate(zebraX + zebraZ) * 0.85);

  // Diorama base outside the road ring, then the studio floor.
  let base = smoothstep(BOARD_HALF - footprint, BOARD_HALF + footprint, edge);
  let floorMix = smoothstep(BASE_HALF - footprint, BASE_HALF + footprint, edge);
  albedo = mix(albedo, vec3f(0.78, 0.74, 0.67), base);
  albedo = mix(albedo, vec3f(0.84, 0.8, 0.74), floorMix);
  let bevel = band(abs(edge - BASE_HALF), 0.08, footprint);
  albedo *= 1.0 - bevel * 0.25;

  let normal = vec3f(0.0, 1.0, 0.0);
  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, input.worldPosition, normal);
  // Soft contact shade where the road meets a tile slab.
  let fromSlab = max(tileOffset.x, tileOffset.y) - TILE_SIZE * 0.5;
  let inBoard = select(0.0, 1.0, edge < BOARD_HALF);
  let occlusion = mix(1.0, mix(0.7, 1.0, saturate(fromSlab / 0.8)), inBoard);
  let radiance = shade(albedo, normal, scene.sunDirection, scene.sunColor, scene.skyColor, shadow, occlusion);
  return finish(radiance, input.worldPosition, scene.fogColor, scene.exposure);
}

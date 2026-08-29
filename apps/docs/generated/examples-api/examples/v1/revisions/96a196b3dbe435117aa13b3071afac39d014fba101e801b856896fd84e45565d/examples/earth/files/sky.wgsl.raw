// Procedural stars, galactic dust, and an HDR sun.

import { fbm3, saturate } from "./planet-common.wgsl";
import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

const DUST_AXIS = vec3f(-0.3227, 0.7561, 0.5670);
const DUST_COOL = vec3f(0.085, 0.100, 0.170);
const DUST_WARM = vec3f(0.200, 0.170, 0.150);
const STAR_COOL = vec3f(0.72, 0.82, 1.00);
const STAR_WARM = vec3f(1.00, 0.84, 0.62);
const STAR_INTENSITY = 0.5;
const SUN_COLOR = vec3f(1.0, 0.647, 0.0);

struct SkyUniforms {
  right: vec3f,
  tanHalfFov: f32,
  up: vec3f,
  aspect: f32,
  forward: vec3f,
  lightDirection: vec3f,
};

@group(0) @binding(0) var<uniform> sky: SkyUniforms;

fn faceCoords(direction: vec3f) -> vec3f {
  let magnitude = abs(direction);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    return vec3f(direction.yz / magnitude.x, select(1.0, 0.0, direction.x > 0.0));
  }
  if (magnitude.y >= magnitude.z) {
    return vec3f(direction.xz / magnitude.y, select(3.0, 2.0, direction.y > 0.0));
  }
  return vec3f(direction.xy / magnitude.z, select(5.0, 4.0, direction.z > 0.0));
}

fn starLayer(direction: vec3f, cells: f32, density: f32, size: f32, seed: i32) -> vec3f {
  let face = faceCoords(direction);
  let grid = face.xy * cells;
  let cell = floor(grid);
  let hashed = pcg3d(bitcast<vec3u>(vec3i(vec2i(cell), i32(face.z) * 131 + seed)));
  let presence = unitFloat(hashed.x);
  if (presence > density) {
    return vec3f(0.0);
  }

  let jitter = vec2f(unitFloat(hashed.y), unitFloat(hashed.z)) - vec2f(0.5);
  let center = cell + vec2f(0.5) + jitter * 0.8;
  let radius = size * (0.45 + unitFloat(hashed.z) * 0.85);
  let falloff = 1.0 - smoothstep(0.0, radius, length(grid - center));
  let bias = presence / max(density, 1.0e-4);
  let magnitude = 0.10 + bias * bias * bias * 1.9;
  let tint = mix(STAR_COOL, STAR_WARM, unitFloat(hashed.y));
  return tint * falloff * falloff * magnitude;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let direction = normalize(
    sky.forward
      + sky.right * ndc.x * sky.tanHalfFov * sky.aspect
      + sky.up * ndc.y * sky.tanHalfFov,
  );

  let band = 1.0 - smoothstep(0.0, 0.34, abs(dot(direction, DUST_AXIS)));
  let dustNoise = saturate(fbm3(direction * 4.2 + vec3f(11.0, -4.0, 23.0), 4) * 0.5 + 0.5);
  var color = mix(DUST_COOL, DUST_WARM, dustNoise) * band * dustNoise * 0.055;

  color = color + (
    starLayer(direction, 34.0, 0.55, 0.16, 17) * 1.35
      + starLayer(direction, 92.0, 0.42, 0.20, 71) * 0.85
      + starLayer(direction, 210.0, 0.26, 0.26, 149) * 0.30
  ) * STAR_INTENSITY;
  let sunAngle = dot(direction, normalize(sky.lightDirection));
  let disk = smoothstep(0.99975, 0.99991, sunAngle);
  let corona = pow(saturate(sunAngle), 2200.0);
  color = color + SUN_COLOR * 12.0 * (disk + corona * 0.35);

  return vec4f(color, 1.0);
}

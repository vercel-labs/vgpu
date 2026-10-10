import { saturate } from "@vgpu/wgsl-std/math";
import { Camera, Scene, Surface, backgroundColor, finish, lightSurface, sunShadow } from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

// Keep in sync with terrain.ts (HALF) and meshes.ts (PLINTH_DEPTH).
const HALF: f32 = 7.5;
const FLOOR_Y: f32 = -0.9;

struct FloorVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
}

// The studio floor the plinth stands on: a big plane that fades into the backdrop.
@vertex
fn vs_main(@location(0) position: vec3f) -> FloorVarying {
  var output: FloorVarying;
  output.worldPosition = vec3f(position.x, FLOOR_Y, position.z);
  output.clip = camera.viewProjection * vec4f(output.worldPosition, 1.0);
  return output;
}

@fragment
fn fs_main(input: FloorVarying) -> @location(0) vec4f {
  let p = input.worldPosition;
  let n = vec3f(0.0, 1.0, 0.0);
  // Contact shade hugging the plinth's foot.
  let outside = max(abs(p.x), abs(p.z)) - HALF;
  let contact = mix(0.35, 1.0, saturate(outside / 1.2));
  let surface = Surface(vec3f(0.2, 0.2, 0.2), vec3f(0.03), 14.0, contact, vec3f(0.0));
  let viewDirection = normalize(camera.eye - p);
  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, p, n);
  let lit = finish(lightSurface(surface, n, viewDirection, scene.sunDirection, scene.sunColor, scene.skyColor, shadow), scene.exposure);
  let fade = smoothstep(HALF + 1.0, HALF + 14.0, length(p.xz));
  return vec4f(mix(lit.rgb, backgroundColor(0.0), fade), 1.0);
}

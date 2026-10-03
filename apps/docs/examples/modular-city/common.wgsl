import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

// Shared by every city shader. Each shader declares its own bindings with these structs:
// @group(0) @binding(0) camera, @binding(1) scene, @binding(2) shadowMap, @binding(3) shadowSampler.

export struct Camera {
  viewProjection: mat4x4f,
  eye: vec3f,
  // World units per output pixel at view distance 1 (outline widths).
  pixelScale: f32,
}

export struct Scene {
  lightViewProjection: mat4x4f,
  sunDirection: vec3f,
  sunColor: vec3f,
  selectedBuilding: u32,
  skyColor: vec3f,
  selectedNeighborhood: u32,
  fogColor: vec3f,
  exposure: f32,
  highlightColor: vec3f,
  outlineWidth: f32,
}

// Material codes (style.x); keep in sync with MATERIAL in layout.ts.
export const MATERIAL_FACADE: u32 = 0u;
export const MATERIAL_GLASS: u32 = 1u;
export const MATERIAL_ROOF: u32 = 2u;
export const MATERIAL_PLAIN: u32 = 3u;
export const MATERIAL_SLAB: u32 = 4u;
export const MATERIAL_FOLIAGE: u32 = 5u;
export const MATERIAL_TRUNK: u32 = 6u;

export const SHADOW_TEXEL: f32 = 1.0 / 2048.0;

/** World-space scale of each local axis (instance records carry translation, rotation and scale). */
export fn axisLengths(world: mat4x4f) -> vec3f {
  return vec3f(length(world[0].xyz), length(world[1].xyz), length(world[2].xyz));
}

/** 3×3 PCF on the sun shadow map. Uses explicit-level comparisons so it may run in any branch. */
export fn sunShadow(
  map: texture_depth_2d,
  comparison: sampler_comparison,
  lightViewProjection: mat4x4f,
  worldPosition: vec3f,
  normal: vec3f,
) -> f32 {
  let offsetPosition = worldPosition + normal * 0.05;
  let clip = lightViewProjection * vec4f(offsetPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) {
    return 1.0;
  }
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y)) * SHADOW_TEXEL * 1.25;
      lit += textureSampleCompareLevel(map, comparison, uv + offset, ndc.z - 0.0015);
    }
  }
  return lit / 9.0;
}

/** Cool sky above, warm bounce below. */
export fn hemisphere(normal: vec3f, sky: vec3f) -> vec3f {
  let up = normal.y * 0.5 + 0.5;
  return mix(vec3f(0.30, 0.25, 0.20) * 0.55, sky, up);
}

/** Warm sun, hemisphere ambient with occlusion, optional emission. Returns linear radiance. */
export fn shade(
  albedo: vec3f,
  normal: vec3f,
  sunDirection: vec3f,
  sunColor: vec3f,
  sky: vec3f,
  shadow: f32,
  occlusion: f32,
) -> vec3f {
  let diffuse = max(dot(normal, sunDirection), 0.0) * shadow;
  return albedo * (sunColor * diffuse + hemisphere(normal, sky) * occlusion);
}

/** Aerial fog, tone mapping and sRGB encoding: the scene target stores display-ready color. */
export fn finish(radiance: vec3f, worldPosition: vec3f, fogColor: vec3f, exposure: f32) -> vec4f {
  let mapped = linearToSrgb3(tonemapAces(radiance * exposure));
  // Studio haze grows with the distance from the board, not from the camera, so zooming out on a
  // portrait phone does not fade the city away.
  let fog = smoothstep(70.0, 230.0, length(worldPosition.xz));
  return vec4f(mix(mapped, fogColor, fog), 1.0);
}

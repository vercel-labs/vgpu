import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { saturate } from "@vgpu/wgsl-std/math";

// Shared by every training-ground shader. Each shader declares its own bindings with these structs:
// @group(0) @binding(0) camera, @binding(1) scene, @binding(2) shadowMap, @binding(3) shadowSampler.

export struct Camera {
  viewProjection: mat4x4f,
  eye: vec3f,
  // Device pixels per CSS pixel (debug line widths are authored in CSS pixels).
  pixelRatio: f32,
  viewport: vec2f,
}

export struct Scene {
  lightViewProjection: mat4x4f,
  sunDirection: vec3f,
  exposure: f32,
  sunColor: vec3f,
  time: f32,
  skyColor: vec3f,
  // Robots whose bodies darken the ground under them (the first contactCount entries of contacts).
  contactCount: u32,
  // Brush: x, z, radius, mode (0 hidden, 1 elevate, -1 lower, 2 destination aim).
  brush: vec4f,
  // Destination: x, z, shown (0/1), seconds since it was set.
  destination: vec4f,
  // Robot bodies for the terrain's contact shade: x, y, z, radius (keep 48 = MAX_ROBOTS).
  contacts: array<vec4f, 48>,
}

export fn backgroundColor(height: f32) -> vec3f {
  // Display-encoded neutral gray backdrop (the scene target stores tone-mapped sRGB).
  return mix(vec3f(0.5, 0.505, 0.51), vec3f(0.66, 0.665, 0.67), saturate(height));
}

// Material codes carried per vertex; keep in sync with MATERIAL in meshes.ts.
export const MATERIAL_YELLOW: u32 = 0u;
export const MATERIAL_PANEL: u32 = 1u;
export const MATERIAL_GRAPHITE: u32 = 2u;
export const MATERIAL_LENS: u32 = 3u;
export const MATERIAL_LED: u32 = 4u;
export const MATERIAL_RUBBER: u32 = 5u;
export const MATERIAL_METAL: u32 = 6u;
export const MATERIAL_PLINTH: u32 = 7u;

export const SHADOW_TEXEL: f32 = 1.0 / 2048.0;

/** 3×3 PCF on the sun shadow map. Uses explicit-level comparisons so it may run in any branch. */
export fn sunShadow(
  map: texture_depth_2d,
  comparison: sampler_comparison,
  lightViewProjection: mat4x4f,
  worldPosition: vec3f,
  normal: vec3f,
) -> f32 {
  let offsetPosition = worldPosition + normal * 0.012;
  let clip = lightViewProjection * vec4f(offsetPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) {
    return 1.0;
  }
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y)) * SHADOW_TEXEL * 1.2;
      lit += textureSampleCompareLevel(map, comparison, uv + offset, ndc.z - 0.0008);
    }
  }
  return lit / 9.0;
}

/** Studio light: a neutral sky dome above and a gray bounce off the concrete below. */
export fn ambient(normal: vec3f, sky: vec3f) -> vec3f {
  let up = normal.y * 0.5 + 0.5;
  return mix(vec3f(0.14, 0.14, 0.14), sky, up);
}

/** Surface response: diffuse plus a Blinn-Phong lobe with Schlick fresnel. */
export struct Surface {
  albedo: vec3f,
  // Specular colour at normal incidence (dielectrics ~0.04, metals their own tint).
  specular: vec3f,
  // Blinn-Phong exponent.
  shininess: f32,
  occlusion: f32,
  emission: vec3f,
}

export fn lightSurface(
  surface: Surface,
  normal: vec3f,
  viewDirection: vec3f,
  sunDirection: vec3f,
  sunColor: vec3f,
  sky: vec3f,
  shadow: f32,
) -> vec3f {
  let n = normalize(normal);
  let ndl = max(dot(n, sunDirection), 0.0);
  let halfVector = normalize(sunDirection + viewDirection);
  let ndh = max(dot(n, halfVector), 0.0);
  let ndv = saturate(dot(n, viewDirection));
  let fresnel = surface.specular + (vec3f(1.0) - surface.specular) * pow(1.0 - ndv, 5.0);
  let normalization = (surface.shininess + 8.0) / 25.0;
  let lobe = pow(ndh, surface.shininess) * normalization * ndl * shadow;
  let diffuse = surface.albedo * (sunColor * ndl * shadow + ambient(n, sky) * surface.occlusion);
  // A soft reflection of the studio dome: brighter toward the top, faint toward the floor.
  let reflected = reflect(-viewDirection, n);
  let dome = mix(vec3f(0.06), sky * 1.3, smoothstep(-0.2, 0.8, reflected.y));
  let gloss = saturate((surface.shininess - 8.0) / 120.0);
  return diffuse + sunColor * fresnel * lobe + fresnel * dome * gloss * surface.occlusion + surface.emission;
}

/** Tone mapping and sRGB encoding: the scene target stores display-ready color. */
export fn finish(radiance: vec3f, exposure: f32) -> vec4f {
  return vec4f(linearToSrgb3(tonemapAces(radiance * exposure)), 1.0);
}

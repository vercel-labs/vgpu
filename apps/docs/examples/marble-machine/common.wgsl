// Shared studio lighting for the machine, the marbles, the shadow pass and the backdrop.

import { tonemapAces, linearToSrgb3 } from "@vgpu/wgsl-std/color";

export struct Studio {
  viewProjection: mat4x4f,
  lightViewProjection: mat4x4f,
  eye: vec3f,
  tanHalfFov: f32,
  right: vec3f,
  aspect: f32,
  up: vec3f,
  exposure: f32,
  forward: vec3f,
  shadowTexel: f32,
  keyDirection: vec3f,
  time: f32,
}

const PI: f32 = 3.14159265;
const KEY_COLOR: vec3f = vec3f(1.0, 0.9, 0.76) * 3.3;
const FILL_DIRECTION: vec3f = vec3f(0.62, 0.3, 0.72);
const FILL_COLOR: vec3f = vec3f(0.45, 0.58, 0.85) * 0.5;
const RIM_DIRECTION: vec3f = vec3f(0.35, 0.55, -0.76);
const RIM_COLOR: vec3f = vec3f(0.9, 0.95, 1.0) * 1.1;

/**
 * The cyclorama seen along `direction`: a dark slate horizon that falls to near black overhead,
 * with a warm pool of light on the wall behind the machine.
 */
export fn backdropColor(direction: vec3f) -> vec3f {
  let horizon = vec3f(0.062, 0.068, 0.08);
  let overhead = vec3f(0.01, 0.012, 0.018);
  var color = mix(horizon, overhead, smoothstep(-0.02, 0.5, direction.y));
  let pool = pow(max(dot(direction, normalize(vec3f(0.08, 0.2, -1.0))), 0.0), 6.0);
  color += vec3f(0.2, 0.13, 0.075) * pool;
  return color;
}

/** What glossy surfaces reflect: the cyclorama, a floor bounce, a dim ceiling diffuser and two softboxes. */
export fn environment(direction: vec3f, keyDirection: vec3f) -> vec3f {
  var color = backdropColor(direction);
  color = mix(color, vec3f(0.11, 0.12, 0.13), smoothstep(0.02, -0.3, direction.y));
  // Up-facing brass would otherwise mirror the black ceiling and read as a hole.
  color += vec3f(0.16, 0.15, 0.14) * smoothstep(0.25, 0.75, direction.y);
  let key = smoothstep(0.9, 0.975, dot(direction, keyDirection));
  let strip = smoothstep(0.78, 0.96, direction.y) * smoothstep(0.6, 0.2, abs(direction.x));
  return color + vec3f(3.2, 2.9, 2.5) * key + vec3f(0.8, 0.85, 0.95) * strip;
}

/** 3×3 percentage-closer filter on top of the comparison sampler's own 2×2 blend. */
export fn keyShadow(
  map: texture_depth_2d,
  comparison: sampler_comparison,
  studio: Studio,
  position: vec3f,
  normal: vec3f,
) -> f32 {
  let offsetPosition = position + normal * studio.shadowTexel * 1.5;
  let clip = studio.lightViewProjection * vec4f(offsetPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let texel = 1.0 / vec2f(textureDimensions(map));
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      lit += textureSampleCompareLevel(map, comparison, uv + vec2f(f32(x), f32(y)) * texel * 1.3, ndc.z - 0.0004);
    }
  }
  // Outside the fitted light frustum nothing casts: fully lit.
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z <= 1.0;
  return select(1.0, lit / 9.0, inside);
}

fn ggx(normal: vec3f, halfway: vec3f, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let cosine = max(dot(normal, halfway), 0.0);
  let denominator = cosine * cosine * (alpha2 - 1.0) + 1.0;
  return alpha2 / (PI * denominator * denominator);
}

fn schlick(f0: vec3f, cosine: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosine, 5.0);
}

fn directLight(
  albedo: vec3f,
  f0: vec3f,
  metallic: f32,
  roughness: f32,
  normal: vec3f,
  toEye: vec3f,
  toLight: vec3f,
  radiance: vec3f,
) -> vec3f {
  let diffuseCosine = max(dot(normal, toLight), 0.0);
  let halfway = normalize(toLight + toEye);
  let fresnel = schlick(f0, max(dot(halfway, toEye), 0.0));
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let viewCosine = max(dot(normal, toEye), 1e-3);
  let geometry = viewCosine / (viewCosine * (1.0 - k) + k) * diffuseCosine / (diffuseCosine * (1.0 - k) + k);
  let specular = ggx(normal, halfway, roughness) * geometry * fresnel / (4.0 * viewCosine * diffuseCosine + 1e-4);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - metallic) * albedo / PI;
  return (diffuse + specular) * radiance * diffuseCosine;
}

/** A surface's shading inputs; `occlusion` darkens only the ambient terms. */
export struct Surface {
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
  occlusion: f32,
  /** Extra mirror-like reflection on top of the base, e.g. a lacquer or glass coat. */
  coat: f32,
}

/** Key (shadowed), cool fill, rim, a studio reflection and a sky/floor hemisphere; linear radiance. */
export fn shade(studio: Studio, surface: Surface, position: vec3f, normal: vec3f, shadow: f32) -> vec3f {
  let toEye = normalize(studio.eye - position);
  let f0 = mix(vec3f(0.04), surface.albedo, surface.metallic);
  let roughness = surface.roughness;
  var color = directLight(surface.albedo, f0, surface.metallic, roughness, normal, toEye, studio.keyDirection, KEY_COLOR * shadow);
  color += directLight(surface.albedo, f0, surface.metallic, roughness, normal, toEye, normalize(FILL_DIRECTION), FILL_COLOR);
  color += directLight(surface.albedo, f0, surface.metallic, roughness, normal, toEye, normalize(RIM_DIRECTION), RIM_COLOR);

  let viewCosine = max(dot(normal, toEye), 0.0);
  let reflected = reflect(-toEye, normal);
  let blurred = normalize(mix(reflected, normal, roughness * roughness));
  let fresnel = f0 + (max(vec3f(1.0 - roughness), f0) - f0) * pow(1.0 - viewCosine, 5.0);
  let shadowed = mix(0.4, 1.0, shadow);
  color += environment(blurred, studio.keyDirection) * fresnel * mix(0.3, 1.0, surface.metallic) * shadowed * surface.occlusion;
  if (surface.coat > 0.0) {
    let coatFresnel = 0.04 + 0.96 * pow(1.0 - viewCosine, 5.0);
    color += environment(reflected, studio.keyDirection) * coatFresnel * surface.coat * shadowed;
  }
  let sky = mix(vec3f(0.07, 0.065, 0.06), vec3f(0.11, 0.13, 0.17), normal.y * 0.5 + 0.5);
  color += sky * surface.albedo * (1.0 - surface.metallic) * surface.occlusion;
  return color;
}

/** Filmic curve plus sRGB encoding: the scene target stores display values. */
export fn display(radiance: vec3f, exposure: f32) -> vec3f {
  return linearToSrgb3(clamp(tonemapAces(radiance * exposure), vec3f(0.0), vec3f(1.0)));
}

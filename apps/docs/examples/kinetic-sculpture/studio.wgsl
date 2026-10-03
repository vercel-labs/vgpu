// Shared studio lighting for the sculpture, the shadow pass and the backdrop.

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
  plinthTop: f32,
  plinthHalf: vec2f,
  pad: vec2f,
}

const KEY_COLOR: vec3f = vec3f(1.0, 0.84, 0.64) * 3.1;
const FILL_DIRECTION: vec3f = vec3f(0.74, 0.3, 0.6);
const FILL_COLOR: vec3f = vec3f(0.52, 0.62, 0.8) * 0.55;
const RIM_DIRECTION: vec3f = vec3f(0.25, 0.42, -0.87);
const RIM_COLOR: vec3f = vec3f(1.0, 0.93, 0.85) * 1.9;
const PI: f32 = 3.14159265;

/** The cyclorama colour seen along `direction`: a warm greige wall with a spotlight pool behind the mobile. */
export fn wallColor(direction: vec3f) -> vec3f {
  let height = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
  let base = mix(vec3f(0.07, 0.06, 0.053), vec3f(0.018, 0.017, 0.017), smoothstep(0.42, 0.9, height));
  // The pool sits on the far wall (-z) and slightly above the horizon.
  let pool = pow(max(dot(direction, normalize(vec3f(-0.12, 0.16, -1.0))), 0.0), 14.0);
  return base + vec3f(0.24, 0.195, 0.15) * pool;
}

/**
 * The environment a metal surface reflects: the wall, the floor bounce and two softboxes,
 * one along the key light and a long strip overhead.
 */
export fn environment(direction: vec3f, keyDirection: vec3f) -> vec3f {
  var color = wallColor(direction);
  let floorBounce = smoothstep(0.05, -0.4, direction.y);
  color = mix(color, vec3f(0.16, 0.135, 0.11), floorBounce);
  let key = smoothstep(0.93, 0.985, dot(direction, keyDirection));
  let strip = smoothstep(0.82, 0.97, direction.y) * smoothstep(0.55, 0.15, abs(direction.x));
  return color + vec3f(3.4, 3.0, 2.5) * key + vec3f(0.9, 0.88, 0.84) * strip;
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
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) {
    return 1.0;
  }
  let texel = 1.0 / vec2f(textureDimensions(map));
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      lit += textureSampleCompareLevel(map, comparison, uv + vec2f(f32(x), f32(y)) * texel * 1.4, ndc.z - 0.0008);
    }
  }
  return lit / 9.0;
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
  if (diffuseCosine <= 0.0) {
    return vec3f(0.0);
  }
  let halfway = normalize(toLight + toEye);
  let fresnel = schlick(f0, max(dot(halfway, toEye), 0.0));
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let viewCosine = max(dot(normal, toEye), 1e-3);
  let geometry = viewCosine / (viewCosine * (1.0 - k) + k) * diffuseCosine / (diffuseCosine * (1.0 - k) + k);
  let specular = ggx(normal, halfway, roughness) * geometry * fresnel / (4.0 * viewCosine * diffuseCosine + 1e-4);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - metallic) * albedo / PI;
  return (diffuse + specular) * radiance * diffuseCosine;
}

/** Key (shadowed), cool fill, rim, and a studio reflection; returns linear radiance. */
export fn shade(
  studio: Studio,
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
  position: vec3f,
  normal: vec3f,
  shadow: f32,
) -> vec3f {
  let toEye = normalize(studio.eye - position);
  let f0 = mix(vec3f(0.04), albedo, metallic);
  var color = directLight(albedo, f0, metallic, roughness, normal, toEye, studio.keyDirection, KEY_COLOR * shadow);
  color += directLight(albedo, f0, metallic, roughness, normal, toEye, normalize(FILL_DIRECTION), FILL_COLOR);
  color += directLight(albedo, f0, metallic, roughness, normal, toEye, normalize(RIM_DIRECTION), RIM_COLOR);

  // Image-based terms: a sharp-ish reflection for metals, a hemisphere for matte surfaces.
  let viewCosine = max(dot(normal, toEye), 0.0);
  let reflected = reflect(-toEye, normal);
  let blurred = normalize(mix(reflected, normal, roughness * roughness));
  let fresnel = f0 + (max(vec3f(1.0 - roughness), f0) - f0) * pow(1.0 - viewCosine, 5.0);
  let reflection = environment(blurred, studio.keyDirection) * mix(0.35, 1.0, shadow * 0.5 + 0.5);
  color += reflection * fresnel * mix(0.25, 1.0, metallic);
  let sky = mix(vec3f(0.12, 0.105, 0.095), vec3f(0.07, 0.075, 0.085), normal.y * 0.5 + 0.5);
  color += sky * albedo * (1.0 - metallic);
  return color;
}

/** Filmic curve plus sRGB encoding: the scene target stores display values. */
export fn display(radiance: vec3f, exposure: f32) -> vec3f {
  let x = radiance * exposure;
  let mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return pow(clamp(mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

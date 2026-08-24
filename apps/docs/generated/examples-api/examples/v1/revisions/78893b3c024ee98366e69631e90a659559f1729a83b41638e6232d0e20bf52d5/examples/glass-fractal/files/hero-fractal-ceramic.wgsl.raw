import {
  HERO_KEY_LIGHT_COLOR,
  HERO_KEY_LIGHT_POSITION,
} from "./hero-fractal-light.wgsl";

const PI = 3.14159265359;
const CERAMIC_F0 = vec3f(0.04);

export struct CeramicMaterial {
  baseColor: vec3f,
  roughness: f32,
  diffuseStrength: f32,
  specularStrength: f32,
  ambientStrength: f32,
  lightIntensity: f32,
}

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn distributionGgx(normal: vec3f, halfway: vec3f, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let nDotH = saturate(dot(normal, halfway));
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(PI * denominator * denominator, 0.00001);
}

fn geometrySchlickGgx(nDotDirection: f32, roughness: f32) -> f32 {
  let radius = roughness + 1.0;
  let k = radius * radius / 8.0;
  return nDotDirection / max(nDotDirection * (1.0 - k) + k, 0.00001);
}

fn geometrySmith(
  normal: vec3f,
  view: vec3f,
  light: vec3f,
  roughness: f32,
) -> f32 {
  return geometrySchlickGgx(saturate(dot(normal, view)), roughness) *
    geometrySchlickGgx(saturate(dot(normal, light)), roughness);
}

fn fresnelSchlick(cosine: f32) -> vec3f {
  return CERAMIC_F0 + (vec3f(1.0) - CERAMIC_F0) *
    pow(1.0 - saturate(cosine), 5.0);
}

export fn shadeCeramic(
  surfacePosition: vec3f,
  viewDirection: vec3f,
  surfaceNormal: vec3f,
  material: CeramicMaterial,
) -> vec3f {
  let view = normalize(viewDirection);
  let normal = normalize(surfaceNormal);
  let toLight = HERO_KEY_LIGHT_POSITION - surfacePosition;
  let lightDistance = length(toLight);
  let light = toLight / max(lightDistance, 0.00001);
  let halfway = normalize(view + light);
  let nDotL = saturate(dot(normal, light));
  let nDotV = saturate(dot(normal, view));
  let roughness = clamp(material.roughness, 0.08, 1.0);

  let distribution = distributionGgx(normal, halfway, roughness);
  let geometry = geometrySmith(normal, view, light, roughness);
  let fresnel = fresnelSchlick(dot(halfway, view));
  let specular = distribution * geometry * fresnel /
    max(4.0 * nDotV * nDotL, 0.0001);
  let diffuse = (vec3f(1.0) - fresnel) * material.baseColor / PI;

  // A gentle inverse-square rolloff keeps the nearby point light readable
  // without turning it into an unbounded hotspot.
  let attenuation = 1.0 / (1.0 + 0.055 * lightDistance * lightDistance);
  let radiance = HERO_KEY_LIGHT_COLOR * material.lightIntensity * attenuation;
  let direct = (
    diffuse * material.diffuseStrength +
    specular * material.specularStrength
  ) * radiance * nDotL;

  // Directionless room fill plus a small white-floor bounce. Neither competes
  // with the key light for which face should read as the illuminated one.
  let floorFacing = saturate(-normal.y);
  let ambientColor = mix(
    vec3f(0.92, 0.94, 0.98),
    vec3f(1.0, 0.96, 0.90),
    floorFacing,
  );
  let ambient = material.baseColor * ambientColor * material.ambientStrength;
  return direct + ambient;
}

fn ceramicAces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + vec3f(b))) /
      (color * (c * color + vec3f(d)) + vec3f(e)),
    vec3f(0.0),
    vec3f(1.0),
  );
}

export fn presentCeramic(color: vec3f) -> vec4f {
  let mapped = ceramicAces(color * 1.08);
  return vec4f(pow(mapped, vec3f(1.0 / 2.2)), 1.0);
}

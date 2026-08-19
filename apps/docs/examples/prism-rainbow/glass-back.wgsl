// Inner/back interface of the prism.
//
// Rendering back faces first lets the outer pass sample the result at the exact
// point its camera ray leaves the solid. In camera-ray order this interface is
// glass -> air, so Snell uses eta = IOR. The refracted ray is then intersected
// with the real wall plane instead of being approximated by a fixed UV offset.

import {
  Glass,
  dielectricFresnel,
  glassEnvironment,
  projectToUv,
  sampleScene,
} from "./glass-common.wgsl";

@group(0) @binding(0) var<uniform> params: Glass;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  // Back-facing triangles expose their inward normal to the camera ray.
  let inwardNormal = -normalize(in.worldNormal);
  let facing = clamp(dot(view, inwardNormal), 0.0, 1.0);
  let refractedRaw = refract(incident, inwardNormal, params.ior);
  let refractedLength = length(refractedRaw);
  let refracted = refractedRaw / max(refractedLength, 0.00001);
  let wallDenominator = refracted.z;
  let wallDistance = (params.wallZ - in.worldPosition.z) / select(
    0.00001,
    wallDenominator,
    abs(wallDenominator) > 0.00001,
  );
  let validWallHit = refractedLength > 0.00001 && wallDistance > 0.00001;

  let originalUv = in.position.xy / max(params.resolution, vec2f(1.0));
  let wallPoint = in.worldPosition + refracted * max(wallDistance, 0.0);
  let refractedUv = select(
    originalUv,
    projectToUv(wallPoint, params.viewProjection),
    validWallHit,
  );
  let halfTexel = 0.5 / max(params.resolution, vec2f(1.0));
  let sceneColor = sampleScene(sceneTexture, sceneSampler, refractedUv, halfTexel);

  let reflectedEnvironment = glassEnvironment(
    reflect(incident, inwardNormal),
    params,
  ) * params.reflectionStrength;
  // A failed refract is total internal reflection: no wall energy crosses this
  // interface and Fresnel becomes one regardless of the Schlick approximation.
  let fresnel = select(
    1.0,
    dielectricFresnel(params.ior, facing),
    validWallHit,
  );
  let transmitted = select(vec3f(0.0), sceneColor, validWallHit);
  return vec4f(mix(transmitted, reflectedEnvironment, fresnel), 1.0);
}

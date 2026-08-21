import {
  presentCeramic,
} from "./hero-fractal-ceramic.wgsl";
import {
  heroFractalFaceNormal,
  heroFractalFacePosition,
  heroFractalSkillRotation,
  heroFractalSphereMix,
  heroFractalSphereNormal,
  heroFractalSpherePosition,
} from "./hero-fractal-face-instance.wgsl";
import {
  rotateHeroEnvironmentDirection,
  sampleHeroEnvironmentLevel,
} from "./hero-glass-environment.wgsl";

const RUBBER_F0 = vec3f(0.028);

struct SoftRubberMaterial {
  baseColor: vec3f,
  roughness: f32,
  diffuseStrength: f32,
  specularStrength: f32,
  ambientStrength: f32,
}

struct MeshParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  meshMin: vec3f,
  meshMax: vec3f,
  sphereMix: f32,
  time: f32,
  material: SoftRubberMaterial,
  environmentRotation: mat4x4f,
  environmentExposure: f32,
}
@group(0) @binding(0) var<uniform> params: MeshParams;
@group(0) @binding(1) var environmentTexture: texture_2d_array<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) ambientOcclusion: f32,
};

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
  @location(2) packed_sphere: vec4f,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  let decodedPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  let sphereMix = heroFractalSphereMix(decodedPosition, params.sphereMix);
  let fractalPosition = heroFractalFacePosition(decodedPosition, instance);
  let sphereSourcePosition = heroFractalFacePosition(
    packed_sphere.xyz,
    instance,
  );
  let spherePosition = heroFractalSpherePosition(
    sphereSourcePosition,
    params.time,
  );
  let sphereNormal = heroFractalSphereNormal(sphereSourcePosition, params.time);
  let transitionRotation = heroFractalSkillRotation(sphereMix);
  let morphPosition = transitionRotation * mix(
    fractalPosition,
    spherePosition,
    sphereMix,
  );
  let fractalNormal = heroFractalFaceNormal(packed_normal.xyz, instance);
  let morphNormal = transitionRotation * normalize(mix(
      fractalNormal,
      sphereNormal,
      sphereMix,
    ));
  let world = params.model * vec4f(morphPosition, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(morphNormal, 0.0)).xyz);
  out.ambientOcclusion = mix(packed_position.w, packed_sphere.w, sphereMix);
  return out;
}

fn environment(direction: vec3f, level: f32) -> vec3f {
  return sampleHeroEnvironmentLevel(
    environmentTexture,
    environmentSampler,
    rotateHeroEnvironmentDirection(direction, params.environmentRotation),
    level,
  ) * params.environmentExposure;
}

fn fresnelSchlick(cosine: f32) -> vec3f {
  return RUBBER_F0 + (vec3f(1.0) - RUBBER_F0) *
    pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  // The generated mesh has consistent outward/cavity winding and is back-face
  // culled. Flipping this normal toward the camera makes diffuse lighting
  // discontinuously change as the orbit crosses a face plane.
  let normal = normalize(in.worldNormal);
  let roughness = clamp(params.material.roughness, 0.08, 1.0);
  let facing = clamp(dot(normal, view), 0.0, 1.0);
  let fresnel = fresnelSchlick(facing);
  let maxEnvironmentLevel = f32(textureNumLevels(environmentTexture) - 1u);

  // The environment is prefiltered once during asset loading. Diffuse uses a
  // broad irradiance-like level, while roughness selects progressively softer
  // studio reflections with a single lookup. Glass continues to sample level
  // zero, so its reflections stay sharp.
  let diffuseEnvironment = environment(normal, maxEnvironmentLevel * 0.72);
  let reflectedDirection = reflect(-view, normal);
  let specularEnvironment = environment(
    reflectedDirection,
    roughness * maxEnvironmentLevel,
  );
  let diffuse = params.material.baseColor * diffuseEnvironment * (
    params.material.diffuseStrength + params.material.ambientStrength * 0.35
  );
  let specular = specularEnvironment * fresnel *
    params.material.specularStrength * mix(0.82, 0.34, roughness);
  let grazingSheen = params.material.baseColor * diffuseEnvironment *
    pow(1.0 - facing, 2.0) * roughness * 0.28;
  let ambientOcclusion = clamp(in.ambientOcclusion, 0.0, 1.0);
  let rubber = (diffuse * (vec3f(1.0) - fresnel) + grazingSheen) *
    ambientOcclusion + specular * mix(0.45, 1.0, ambientOcclusion);
  return presentCeramic(rubber);
}

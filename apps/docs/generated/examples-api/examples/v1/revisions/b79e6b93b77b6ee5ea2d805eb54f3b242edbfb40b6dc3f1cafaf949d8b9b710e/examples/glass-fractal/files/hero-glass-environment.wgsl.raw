struct HeroEnvironmentLookup {
  uv: vec2f,
  face: i32,
}

export fn rotateHeroEnvironmentDirection(
  directionInput: vec3f,
  rotation: mat4x4f,
) -> vec3f {
  return normalize((rotation * vec4f(directionInput, 0.0)).xyz);
}

fn heroEnvironmentLookup(directionInput: vec3f) -> HeroEnvironmentLookup {
  let direction = normalize(directionInput);
  let magnitude = abs(direction);
  var faceUv = vec2f(0.0);
  var face = 0;

  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    if (direction.x >= 0.0) {
      face = 0;
      faceUv = vec2f(-direction.z, -direction.y) / magnitude.x;
    } else {
      face = 1;
      faceUv = vec2f(direction.z, -direction.y) / magnitude.x;
    }
  } else if (magnitude.y >= magnitude.z) {
    if (direction.y >= 0.0) {
      face = 2;
      faceUv = vec2f(direction.x, direction.z) / magnitude.y;
    } else {
      face = 3;
      faceUv = vec2f(direction.x, -direction.z) / magnitude.y;
    }
  } else if (direction.z >= 0.0) {
    face = 4;
    faceUv = vec2f(direction.x, -direction.y) / magnitude.z;
  } else {
    face = 5;
    faceUv = vec2f(-direction.x, -direction.y) / magnitude.z;
  }

  return HeroEnvironmentLookup(faceUv * 0.5 + vec2f(0.5), face);
}

export fn sampleHeroEnvironment(
  environmentTexture: texture_2d_array<f32>,
  environmentSampler: sampler,
  direction: vec3f,
) -> vec3f {
  return sampleHeroEnvironmentLevel(
    environmentTexture,
    environmentSampler,
    direction,
    0.0,
  );
}

export fn sampleHeroEnvironmentLevel(
  environmentTexture: texture_2d_array<f32>,
  environmentSampler: sampler,
  direction: vec3f,
  level: f32,
) -> vec3f {
  let lookup = heroEnvironmentLookup(direction);
  return textureSampleLevel(
    environmentTexture,
    environmentSampler,
    lookup.uv,
    lookup.face,
    level,
  ).rgb;
}

export struct WallNormals {
  large: vec3f,
  micro: vec3f,
  combined: vec3f,
}

fn wallMaterialUv(worldPosition: vec2f, worldScale: f32) -> vec2f {
  // Repeat in world units so viewport aspect changes reveal more surface
  // instead of stretching the normal field.
  return worldPosition / max(worldScale, 0.001);
}

fn normalFromXy(normalXy: vec2f) -> vec3f {
  let limitedXy = normalXy / max(length(normalXy), 1.0);
  return normalize(vec3f(
    limitedXy,
    sqrt(max(1.0 - dot(limitedXy, limitedXy), 0.0001)),
  ));
}

fn wallNormalsFromSamples(
  material: vec4f,
  microMaterial: vec4f,
  normalStrength: f32,
  microNormalStrength: f32,
) -> WallNormals {
  let largeNormalXy = (material.gb * 2.0 - 1.0) * normalStrength;
  let microNormalXy = (microMaterial.gb * 2.0 - 1.0)
    * microNormalStrength;
  return WallNormals(
    normalFromXy(largeNormalXy),
    normalFromXy(microNormalXy),
    normalFromXy(largeNormalXy + microNormalXy),
  );
}

export fn evaluateWallNormalsFromMaterial(
  worldPosition: vec2f,
  materialWorldScale: f32,
  normalStrength: f32,
  microNormalFrequency: f32,
  microNormalStrength: f32,
  material: vec4f,
  wallMaterial: texture_2d<f32>,
  materialSampler: sampler,
) -> WallNormals {
  let microUv = wallMaterialUv(
    worldPosition,
    materialWorldScale / max(microNormalFrequency, 1.0),
  ) + vec2f(0.371, 0.613);
  let microMaterial = textureSampleBias(
    wallMaterial,
    materialSampler,
    microUv,
    -2.0,
  );
  return wallNormalsFromSamples(
    material,
    microMaterial,
    normalStrength,
    microNormalStrength,
  );
}

export fn evaluateWallNormals(
  worldPosition: vec2f,
  materialWorldScale: f32,
  normalStrength: f32,
  microNormalFrequency: f32,
  microNormalStrength: f32,
  wallMaterial: texture_2d<f32>,
  materialSampler: sampler,
) -> WallNormals {
  let material = textureSample(
    wallMaterial,
    materialSampler,
    wallMaterialUv(worldPosition, materialWorldScale),
  );
  return evaluateWallNormalsFromMaterial(
    worldPosition,
    materialWorldScale,
    normalStrength,
    microNormalFrequency,
    microNormalStrength,
    material,
    wallMaterial,
    materialSampler,
  );
}

export fn wallNormalTextureLod(
  worldPosition: vec2f,
  materialWorldScale: f32,
  wallMaterial: texture_2d<f32>,
) -> f32 {
  let uv = wallMaterialUv(worldPosition, materialWorldScale);
  let dimensions = vec2f(textureDimensions(wallMaterial, 0));
  let footprint = max(
    length(dpdx(uv) * dimensions),
    length(dpdy(uv) * dimensions),
  );
  return max(log2(max(footprint, 1.0)), 0.0);
}

export fn evaluateWallNormalsLevel(
  worldPosition: vec2f,
  materialWorldScale: f32,
  normalStrength: f32,
  microNormalFrequency: f32,
  microNormalStrength: f32,
  baseLod: f32,
  wallMaterial: texture_2d<f32>,
  materialSampler: sampler,
) -> WallNormals {
  let material = textureSampleLevel(
    wallMaterial,
    materialSampler,
    wallMaterialUv(worldPosition, materialWorldScale),
    baseLod,
  );
  let frequency = max(microNormalFrequency, 1.0);
  let microMaterial = textureSampleLevel(
    wallMaterial,
    materialSampler,
    wallMaterialUv(worldPosition, materialWorldScale / frequency)
      + vec2f(0.371, 0.613),
    max(baseLod + log2(frequency) - 2.0, 0.0),
  );
  return wallNormalsFromSamples(
    material,
    microMaterial,
    normalStrength,
    microNormalStrength,
  );
}

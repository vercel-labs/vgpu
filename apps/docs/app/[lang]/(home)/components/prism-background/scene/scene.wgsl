// Uniforms shared by the wall and deterministic light-ribbon passes.

export struct Scene {
  viewProjection: mat4x4f,
  wallHalfExtent: vec2f,
  /** XY direction in which the white beam travels toward the prism. */
  inputBeamDirection: vec2f,
  /** User-selected sRGB wall color; the wall pass linearizes it before lighting. */
  wallColor: vec3f,
  /** 1 shows only the generated light over black. */
  causticOnly: u32,
  /** World-space depth of the emissive sheet between the glass interfaces. */
  lightPlaneZ: f32,
  /** Fixed layout metadata used to decimate the debug wireframe. */
  lightWhiteQuads: u32,
  lightBeamSlices: u32,
  lightSpectralSamples: u32,
  lightInternalQuads: u32,
  lightInternalSegments: u32,
  /** User-controlled lateral and outgoing-distance falloff strengths. */
  lightOpacity: f32,
  lightEdgeFalloff: f32,
  rainbowFalloffRate: f32,
  rainbowFalloffPower: f32,
  /** Initial reveal aperture shared by white, internal, and spectral beams. */
  beamWidthReveal: f32,
}

/** Maps top-origin texture coordinates to the wall plane in world space. */
export fn scenePoint(scene: Scene, uv: vec2f) -> vec2f {
  return (uv - vec2f(0.5)) * vec2f(2.0, -2.0) * scene.wallHalfExtent;
}

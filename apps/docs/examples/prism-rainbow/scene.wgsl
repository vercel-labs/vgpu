// Uniforms shared by the wall and deterministic light-ribbon passes.

export struct Scene {
  viewProjection: mat4x4f,
  wallHalfExtent: vec2f,
  /** User-selected sRGB wall color; the wall pass linearizes it before lighting. */
  wallColor: vec3f,
  /** 1 shows only the generated light over black. */
  causticOnly: u32,
}

/** Maps top-origin texture coordinates to the wall plane in world space. */
export fn scenePoint(scene: Scene, uv: vec2f) -> vec2f {
  return (uv - vec2f(0.5)) * vec2f(2.0, -2.0) * scene.wallHalfExtent;
}

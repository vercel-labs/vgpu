export struct ParticleUniforms {
  view: mat4x4f,
  projection: mat4x4f,
  viewport: vec4f,
  simulation: vec4f,
  fade: vec4f,
  oceanColor: vec4f,
  neonColor: vec4f,
  foamColor: vec4f,
  misc: vec4f,
};

export struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) pointCoord: vec2f,
  @location(1) foam: f32,
  @location(2) normal: vec3f,
  @location(3) viewDir: vec3f,
  @location(4) height: f32,
  @location(5) fade: f32,
};

export fn quadCorner(vertexIndex: u32) -> vec2f {
  let cornerIndex = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u)[vertexIndex % 6u];
  switch (cornerIndex) {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f( 1.0, -1.0); }
    case 2u: { return vec2f(-1.0,  1.0); }
    default: { return vec2f( 1.0,  1.0); }
  }
}

export fn particleVertex(
  u: ParticleUniforms,
  displacement: texture_2d<f32>,
  normalFoam: texture_2d<f32>,
  vertexIndex: u32,
  instanceIndex: u32,
) -> VertexOut {
  // --- Particle indexing and texel selection ---------------------------------------
  let resolution = max(1u, u32(u.viewport.w));
  let i = instanceIndex % resolution;
  let j = instanceIndex / resolution;
  let particleRef = vec2f(f32(i), f32(j)) / f32(resolution);
  let texCoord = vec2u(i, j);

  // --- Simulation data sampling -----------------------------------------------------
  let disp = textureLoad(displacement, texCoord, 0).xyz * u.misc.x;
  let nf = textureLoad(normalFoam, texCoord, 0);

  // --- World position construction --------------------------------------------------
  let halfWorld = u.simulation.x * 0.5;
  let base = vec3f(particleRef.x * u.simulation.x - halfWorld, 0.0, particleRef.y * u.simulation.x - halfWorld);
  let pos = base + disp;

  // --- Camera space conversion and distance-based fading ----------------------------
  let mv = u.view * vec4f(pos, 1.0);
  let viewDir = -mv.xyz;
  let dist = -mv.z;
  let f = 1.0 - smoothstep(u.fade.x, u.fade.y, dist);
  let fade = pow(clamp(f, 0.0, 1.0), u.fade.z);

  // --- Continuous projection ---------------------------------------------------------
  let projected = u.projection * mv;
  let ndc = projected.xy / projected.w;

  // --- Point size in clip space -----------------------------------------------------
  let corner = quadCorner(vertexIndex);
  let pointSizePx = 2.0 * u.misc.y * u.viewport.z;
  let clipOffset = corner * (pointSizePx / u.viewport.xy) * projected.w;
  let clip = vec4f(ndc * projected.w + clipOffset, projected.z, projected.w);

  // --- Attribute packing for the fragment shader ------------------------------------
  var out: VertexOut;
  out.position = clip;
  out.pointCoord = corner * 0.5 + vec2f(0.5);
  out.foam = nf.w;
  out.normal = nf.xyz;
  out.viewDir = viewDir;
  out.height = disp.y;
  out.fade = fade;
  return out;
}

export fn spriteMaskDiscard(pointCoord: vec2f) -> bool {
  let cc = pointCoord - vec2f(0.5);
  let d2 = dot(cc, cc);
  return d2 > 0.25;
}

export fn fresnelTerm(normal: vec3f, viewDir: vec3f) -> f32 {
  let n = normalize(normal);
  let v = normalize(viewDir);
  return pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
}

export fn crestMask(height: f32) -> f32 {
  return smoothstep(-0.5, 1.5, height);
}

export fn foamMask(foam: f32) -> f32 {
  return clamp(foam, 0.0, 1.0);
}

export fn screenFade(fragPos: vec4f, viewport: vec2f) -> f32 {
  let screenPos = fragPos.xy / max(viewport, vec2f(1.0));
  return 1.0 - smoothstep(0.62, 0.98, screenPos.y);
}

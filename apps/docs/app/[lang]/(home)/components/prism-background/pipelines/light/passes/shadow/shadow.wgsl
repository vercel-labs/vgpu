struct PrismShadow {
  viewProjection: mat4x4f,
  color: vec3f,
  opacity: f32,
  farStrength: f32,
}

@group(0) @binding(0) var<uniform> shadow: PrismShadow;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) coverage: f32,
  @location(1) travel: f32,
};

@vertex
fn vs_main(
  @location(0) position: vec2f,
  @location(1) coverage: f32,
  @location(2) travel: f32,
) -> VertexOut {
  var out: VertexOut;
  out.position = shadow.viewProjection * vec4f(position, 0.0, 1.0);
  out.coverage = coverage;
  out.travel = travel;
  return out;
}

fn shadowCoverage(in: VertexOut) -> f32 {
  let longitudinal = mix(1.0, shadow.farStrength, smoothstep(0.0, 1.0, in.travel));
  return clamp(in.coverage * shadow.opacity * longitudinal, 0.0, 0.95);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let alpha = shadowCoverage(in);
  return vec4f(shadow.color * alpha, alpha);
}

@fragment
fn fs_debug(in: VertexOut) -> @location(0) vec4f {
  let coverage = shadowCoverage(in);
  return vec4f(vec3f(coverage), 1.0);
}

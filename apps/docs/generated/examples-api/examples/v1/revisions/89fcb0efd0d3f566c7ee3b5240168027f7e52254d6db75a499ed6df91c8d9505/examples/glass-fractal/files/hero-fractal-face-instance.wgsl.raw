// The canonical asset stores tetrahedron face 2. These proper tetrahedral
// rotations place it over the other three faces without changing winding.
// All four instances are needed once the surface bends into a closed sphere.
const SPHERE_MORPH_INNER_DELAY = 0.38;
const SPHERE_MORPH_RADIUS_START = 0.34;
const SPHERE_MORPH_RADIUS_END = 1.0;
const SPHERE_MORPH_REVERSE_STAGGER = 0.14;
const SKILL_ROTATION_Y = -2.09439510239;

// Advance the tetrahedron tips first, then let the morph travel toward the
// deeper cavity vertices. At progress 0 and 1 every vertex still reaches the
// exact authored endpoint, so this only changes the transition between them.
// A negative progress marks the orb -> fractal direction. On the way out we
// keep the full tip-led stagger; on the way back we retain only a hint of it,
// so the body and edges settle together instead of leaving the tips behind.
export fn heroFractalSphereMix(position: vec3f, signedProgress: f32) -> f32 {
  let progress = clamp(abs(signedProgress), 0.0, 1.0);
  let tipWeight = smoothstep(
    SPHERE_MORPH_RADIUS_START,
    SPHERE_MORPH_RADIUS_END,
    length(position),
  );
  let delay = (1.0 - tipWeight) * SPHERE_MORPH_INNER_DELAY;
  let staggeredProgress = clamp(
    (progress - delay) / (1.0 - delay),
    0.0,
    1.0,
  );
  let staggerStrength = select(
    SPHERE_MORPH_REVERSE_STAGGER,
    1.0,
    signedProgress >= 0.0,
  );
  let localProgress = mix(progress, staggeredProgress, staggerStrength);
  return localProgress * localProgress * (3.0 - 2.0 * localProgress);
}

// Rotate each vertex with the same delayed progress used by its morph. This
// sends the tetrahedron tips first and lets the turn travel toward the deeper
// cavity vertices instead of rotating the whole object as a rigid body.
export fn heroFractalSkillRotation(progress: f32) -> mat3x3f {
  let angle = SKILL_ROTATION_Y * clamp(progress, 0.0, 1.0);
  let cosine = cos(angle);
  let sine = sin(angle);
  return mat3x3f(
    vec3f(cosine, 0.0, -sine),
    vec3f(0.0, 1.0, 0.0),
    vec3f(sine, 0.0, cosine),
  );
}

// A low-frequency, volume-preserving-ish wobble for the completed sphere.
// It only changes the sphere target's vertices; glass and material shading
// remain untouched. Keeping the waves in object space makes all four face
// instances meet on the same animated surface.
export fn heroFractalSpherePosition(position: vec3f, time: f32) -> vec3f {
  let direction = normalize(position);
  let stretch = vec3f(
    1.0 + sin(time * 0.73) * 0.06,
    1.0 + sin(time * 0.61 + 2.1) * 0.07,
    1.0 + sin(time * 0.67 + 4.2) * 0.06,
  );
  let wave =
    sin(dot(direction, vec3f(0.811, 0.324, 0.486)) * 3.4 + time * 0.85) *
      0.045 +
    sin(dot(direction, vec3f(-0.365, 0.913, 0.183)) * 4.7 - time * 0.72) *
      0.028 +
    sin(dot(direction, vec3f(0.214, -0.456, 0.864)) * 6.1 + time * 0.48) *
      0.018 +
    sin(dot(direction, vec3f(0.702, 0.117, -0.702)) * 8.8 - time * 1.15) *
      0.012 +
    sin(dot(direction, vec3f(-0.577, -0.577, 0.577)) * 13.2 + time * 1.7) *
      0.007;
  return position * stretch * (1.0 + wave);
}

// Estimate the animated sphere normal from two nearby deformed positions.
// This runs per vertex, keeping the fragment material exactly as authored.
export fn heroFractalSphereNormal(position: vec3f, time: f32) -> vec3f {
  let radius = max(length(position), 0.0001);
  let direction = position / radius;
  var reference = vec3f(0.0, 1.0, 0.0);
  if (abs(direction.y) > 0.85) {
    reference = vec3f(1.0, 0.0, 0.0);
  }
  let tangent = normalize(cross(reference, direction));
  let bitangent = normalize(cross(direction, tangent));
  let epsilon = 0.018;
  let tangentPosition = normalize(direction + tangent * epsilon) * radius;
  let bitangentPosition = normalize(direction + bitangent * epsilon) * radius;
  let center = heroFractalSpherePosition(position, time);
  let tangentSample = heroFractalSpherePosition(tangentPosition, time);
  let bitangentSample = heroFractalSpherePosition(bitangentPosition, time);
  return normalize(cross(tangentSample - center, bitangentSample - center));
}

const FACE_2_TO_FACE_0 = mat3x3f(
  vec3f(-0.16666666667, -0.47140452079, 0.86602540379),
  vec3f(0.94280904158, -0.33333333333, 0.0),
  vec3f(0.28867513459, 0.81649658093, 0.5),
);
const FACE_2_TO_FACE_1 = mat3x3f(
  vec3f(-0.16666666667, 0.94280904158, 0.28867513459),
  vec3f(-0.47140452079, -0.33333333333, 0.81649658093),
  vec3f(0.86602540379, 0.0, 0.5),
);
const FACE_2_TO_FACE_3 = mat3x3f(
  vec3f(0.33333333333, 0.94280904158, 0.0),
  vec3f(0.94280904158, -0.33333333333, 0.0),
  vec3f(0.0, 0.0, -1.0),
);

fn heroFractalFaceTransform(instance: u32) -> mat3x3f {
  if (instance == 1u) { return FACE_2_TO_FACE_3; }
  if (instance == 2u) { return FACE_2_TO_FACE_0; }
  if (instance == 3u) { return FACE_2_TO_FACE_1; }
  return mat3x3f(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0),
  );
}

export fn heroFractalFacePosition(position: vec3f, instance: u32) -> vec3f {
  return heroFractalFaceTransform(instance) * position;
}

export fn heroFractalFaceNormal(normal: vec3f, instance: u32) -> vec3f {
  return heroFractalFaceTransform(instance) * normal;
}

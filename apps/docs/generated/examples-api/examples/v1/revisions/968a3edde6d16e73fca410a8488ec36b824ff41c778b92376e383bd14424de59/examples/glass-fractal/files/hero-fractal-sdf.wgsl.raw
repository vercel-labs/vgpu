// Geometry shared by the camera-depth and floor-light bakes. Keeping this in
// the hero prevents the example implementation from becoming a dependency.

const V0 = vec3f(0.0, 1.0, 0.0);
const V1 = vec3f(0.94280904158, -0.33333333333, 0.0);
const V2 = vec3f(-0.47140452079, -0.33333333333, 0.81649658093);
const V3 = vec3f(-0.47140452079, -0.33333333333, -0.81649658093);
export const HERO_FLOOR_Y = -0.33333333333;
export const HERO_FLOOR_BAKE_EXTENT = 3.0;
const CAVITY_DEPTH = 0.22;
const CAVITY_LIP = 0.006;
const SURFACE_LAYERS = 7;

fn solidTetrahedronDistance(point: vec3f) -> f32 {
  return max(
    max(dot(-V0, point), dot(-V1, point)),
    max(dot(-V2, point), dot(-V3, point)),
  ) - 0.33333333333;
}

fn orientedPlaneNormal(
  a: vec3f,
  b: vec3f,
  c: vec3f,
  insidePoint: vec3f,
) -> vec3f {
  var normal = normalize(cross(b - a, c - a));
  if (dot(normal, insidePoint - a) > 0.0) {
    normal = -normal;
  }
  return normal;
}

fn orientedPlaneDistance(
  point: vec3f,
  a: vec3f,
  b: vec3f,
  c: vec3f,
  insidePoint: vec3f,
) -> f32 {
  return dot(orientedPlaneNormal(a, b, c, insidePoint), point - a);
}

fn tetrahedronFromVerticesDistance(
  point: vec3f,
  a: vec3f,
  b: vec3f,
  c: vec3f,
  d: vec3f,
) -> f32 {
  let face0 = orientedPlaneDistance(point, a, b, c, d);
  let face1 = orientedPlaneDistance(point, a, d, b, c);
  let face2 = orientedPlaneDistance(point, b, d, c, a);
  let face3 = orientedPlaneDistance(point, c, d, a, b);
  return max(max(face0, face1), max(face2, face3));
}

fn faceCavityDistance(
  point: vec3f,
  inward: vec3f,
  faceA: vec3f,
  faceB: vec3f,
  faceC: vec3f,
  layerScale: f32,
) -> f32 {
  let outward = -inward;
  let lip = CAVITY_LIP * layerScale;
  let base0 = (faceA + faceB) * 0.5 + outward * lip;
  let base1 = (faceB + faceC) * 0.5 + outward * lip;
  let base2 = (faceC + faceA) * 0.5 + outward * lip;
  let faceCenter = (faceA + faceB + faceC) / 3.0;
  let apex = faceCenter + inward * CAVITY_DEPTH * layerScale;
  return tetrahedronFromVerticesDistance(point, base0, base1, base2, apex);
}

fn faceCavitiesDistance(
  point: vec3f,
  inward: vec3f,
  faceA: vec3f,
  faceB: vec3f,
  faceC: vec3f,
) -> f32 {
  var triangleA = faceA;
  var triangleB = faceB;
  var triangleC = faceC;
  var layerScale = 1.0;
  var cavities = 100000.0;

  for (var layer = 0; layer < SURFACE_LAYERS; layer++) {
    cavities = min(cavities, faceCavityDistance(
      point,
      inward,
      triangleA,
      triangleB,
      triangleC,
      layerScale,
    ));

    let midpointAB = (triangleA + triangleB) * 0.5;
    let midpointBC = (triangleB + triangleC) * 0.5;
    let midpointCA = (triangleC + triangleA) * 0.5;
    let deltaA = point - triangleA;
    let deltaB = point - triangleB;
    let deltaC = point - triangleC;
    let distanceA = dot(deltaA, deltaA);
    let distanceB = dot(deltaB, deltaB);
    let distanceC = dot(deltaC, deltaC);

    if (distanceA <= distanceB && distanceA <= distanceC) {
      triangleB = midpointAB;
      triangleC = midpointCA;
    } else if (distanceB <= distanceC) {
      triangleA = triangleB;
      triangleB = midpointBC;
      triangleC = midpointAB;
    } else {
      triangleA = triangleC;
      triangleB = midpointCA;
      triangleC = midpointBC;
    }
    layerScale *= 0.5;
  }
  return cavities;
}

fn allCavitiesDistance(point: vec3f) -> f32 {
  let cavity0 = faceCavitiesDistance(point, V0, V1, V2, V3);
  let cavity1 = faceCavitiesDistance(point, V1, V0, V3, V2);
  let cavity2 = faceCavitiesDistance(point, V2, V0, V1, V3);
  let cavity3 = faceCavitiesDistance(point, V3, V0, V2, V1);
  return min(min(cavity0, cavity1), min(cavity2, cavity3));
}

fn fractalDistance(point: vec3f) -> f32 {
  return max(solidTetrahedronDistance(point), -allCavitiesDistance(point));
}

// Evaluated once at the baked primary-ray hit. The tetrahedral stencil avoids
// the cross-face contamination produced by reconstructing normals from nearby
// depth pixels, which is especially visible on the fractal's dense edges.
export fn heroFractalNormal(point: vec3f) -> vec3f {
  let epsilon = 0.00018;
  let offset0 = vec3f(1.0, -1.0, -1.0);
  let offset1 = vec3f(-1.0, -1.0, 1.0);
  let offset2 = vec3f(-1.0, 1.0, -1.0);
  let offset3 = vec3f(1.0, 1.0, 1.0);
  return normalize(
    offset0 * fractalDistance(point + offset0 * epsilon) +
    offset1 * fractalDistance(point + offset1 * epsilon) +
    offset2 * fractalDistance(point + offset2 * epsilon) +
    offset3 * fractalDistance(point + offset3 * epsilon)
  );
}

fn clipPlane(ro: vec3f, rd: vec3f, normal: vec3f, interval: vec2f) -> vec2f {
  let a = dot(normal, ro) - 0.33333333333;
  let b = dot(normal, rd);
  if (abs(b) < 0.000001) {
    if (a > 0.0) { return vec2f(1.0, -1.0); }
    return interval;
  }
  let t = -a / b;
  if (b < 0.0) { return vec2f(max(interval.x, t), interval.y); }
  return vec2f(interval.x, min(interval.y, t));
}

fn outerInterval(ro: vec3f, rd: vec3f) -> vec2f {
  var bound = vec2f(-100000.0, 100000.0);
  bound = clipPlane(ro, rd, -V0, bound);
  bound = clipPlane(ro, rd, -V1, bound);
  bound = clipPlane(ro, rd, -V2, bound);
  bound = clipPlane(ro, rd, -V3, bound);
  return bound;
}

// Returns ray distance, or zero for a miss. This is the only primary camera
// raymarch in the optimized hero pipeline.
export fn traceHeroFractal(ro: vec3f, rd: vec3f, maxDistance: f32) -> f32 {
  let bound = outerInterval(ro, rd);
  var t = max(bound.x, 0.0);
  let traceEnd = min(bound.y, maxDistance);
  if (bound.x > traceEnd || traceEnd < 0.0) { return 0.0; }

  // Keep one predictable quality path for both static and interactive frames.
  for (var step = 0; step < 160; step++) {
    let samplePoint = ro + rd * t;
    let outerDistance = solidTetrahedronDistance(samplePoint);
    let cavitiesDistance = allCavitiesDistance(samplePoint);
    let distance = max(outerDistance, -cavitiesDistance);
    let eps = max(0.00005, 0.00002 * t);
    if (distance < eps && cavitiesDistance >= 0.0) {
      return select(0.0, t, t <= traceEnd + eps);
    }
    t += max(distance * 0.8, eps * 0.35);
    if (t > traceEnd) { break; }
  }
  return 0.0;
}

// Evaluated only by the fixed-resolution floor bake, never by the camera pass.
export fn heroSoftShadow(
  ro: vec3f,
  rd: vec3f,
  maxDistance: f32,
  lightRadius: f32,
) -> f32 {
  var visibility = 1.0;
  var t = 0.018;
  for (var step = 0; step < 48; step++) {
    let distance = fractalDistance(ro + rd * t);
    if (distance < 0.0008) { return 0.0; }
    visibility = min(
      visibility,
      distance / max(t * lightRadius / maxDistance, 0.00001),
    );
    t += clamp(distance, 0.008, 0.12);
    if (t >= maxDistance) { break; }
  }
  return clamp(visibility, 0.0, 1.0);
}

// The solid base has distance zero across its triangular footprint. Sampling
// just outside it gives a cheap, stable contact-AO falloff for the floor bake.
export fn heroFloorContactDistance(point: vec2f) -> f32 {
  return max(solidTetrahedronDistance(vec3f(point.x, HERO_FLOOR_Y, point.y)), 0.0);
}

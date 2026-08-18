// Two-dimensional prism optics: triangle sampling, Snell refraction with total
// internal reflection, Cauchy dispersion, and the lamp connection test.
//
// A pure helper module — no bindings, so `vgpu check` can validate it on its own
// and `probe.wgsl` can call into it from a debug entry point. `optics.ts` is a
// function-for-function mirror of this file and the Node GPU test diffs the two,
// so any edit here belongs there as well.

/** Keeps a ray from immediately re-hitting the surface it just left. */
export const surfaceEpsilon: f32 = 1e-4;

export struct Prism {
  a: vec2f,
  b: vec2f,
  c: vec2f,
}

export struct Lamp {
  center: vec2f,
  direction: vec2f,
  radius: f32,
  innerAngle: f32,
  outerAngle: f32,
}

export struct EdgeHit {
  hit: bool,
  /** Distance along the ray. */
  t: f32,
  /** Unit normal pointing out of the triangle. */
  normal: vec2f,
}

export struct Refraction {
  /** False on total internal reflection. */
  valid: bool,
  direction: vec2f,
}

export struct PrismPath {
  valid: bool,
  /** Where the ray left the glass. */
  origin: vec2f,
  /** Unit direction it left with. */
  direction: vec2f,
  /** Internal reflections taken before it got out. */
  bounces: u32,
}

/** z of the 3D cross product of two planar vectors: positive when b is left of a. */
export fn cross2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

/** Signed area doubled; positive for counter-clockwise winding. */
export fn triangleWinding(prism: Prism) -> f32 {
  return cross2(prism.b - prism.a, prism.c - prism.a);
}

/**
 * A uniformly distributed point inside the triangle from two unit randoms.
 *
 * Barycentric coordinates taken straight from two uniforms cover the wrong half
 * of the parallelogram; folding `u + v > 1` back across the diagonal fixes the
 * density without rejecting samples.
 */
export fn sampleTriangle(prism: Prism, u: f32, v: f32) -> vec2f {
  var bu = u;
  var bv = v;
  if (bu + bv > 1.0) {
    bu = 1.0 - bu;
    bv = 1.0 - bv;
  }
  return prism.a + (prism.b - prism.a) * bu + (prism.c - prism.a) * bv;
}

/** True when the point is on the inner side of all three edges. */
export fn insideTriangle(prism: Prism, point: vec2f) -> bool {
  let winding = select(-1.0, 1.0, triangleWinding(prism) >= 0.0);
  let ab = cross2(prism.b - prism.a, point - prism.a) * winding;
  let bc = cross2(prism.c - prism.b, point - prism.b) * winding;
  let ca = cross2(prism.a - prism.c, point - prism.c) * winding;
  return ab >= 0.0 && bc >= 0.0 && ca >= 0.0;
}

/** Cauchy's empirical dispersion law, with the wavelength given in nanometres. */
export fn iorAt(wavelengthNm: f32, base: f32, strength: f32) -> f32 {
  let micrometres = wavelengthNm * 1e-3;
  return base + strength / (micrometres * micrometres);
}

/**
 * The wavelength ray `index` traces, stratified over the visible range.
 *
 * One wavelength per ray, one stratum per ray: the 16 rays cover the spectrum
 * evenly every frame, and `jitter` moves each sample inside its stratum so
 * accumulation converges to the continuous spectrum instead of 16 lines.
 */
export fn stratifiedWavelength(index: u32, count: u32, jitter: f32, minNm: f32, maxNm: f32) -> f32 {
  let t = (f32(index) + jitter) / f32(count);
  return minNm + (maxNm - minNm) * t;
}

/**
 * Nearest crossing of the triangle's boundary strictly beyond `minT`.
 *
 * Works from inside and outside: the caller decides what a hit means by looking
 * at the sign of `dot(direction, normal)`.
 */
export fn intersectTriangle(prism: Prism, origin: vec2f, direction: vec2f, minT: f32) -> EdgeHit {
  var vertices = array<vec2f, 3>(prism.a, prism.b, prism.c);
  var best = EdgeHit(false, 0.0, vec2f(0.0));
  for (var index = 0u; index < 3u; index = index + 1u) {
    let edgeStart = vertices[index];
    let edgeEnd = vertices[(index + 1u) % 3u];
    let edge = edgeEnd - edgeStart;
    let denominator = cross2(direction, edge);
    if (denominator == 0.0) {
      continue;
    }
    let offset = edgeStart - origin;
    let t = cross2(offset, edge) / denominator;
    let s = cross2(offset, direction) / denominator;
    if (t <= minT || s < 0.0 || s > 1.0) {
      continue;
    }
    if (best.hit && best.t <= t) {
      continue;
    }
    // Counter-clockwise winding puts the interior left of every edge, so
    // rotating the edge clockwise points out of the triangle.
    best = EdgeHit(true, t, normalize(vec2f(edge.y, -edge.x)));
  }
  return best;
}

/**
 * Snell's law in the plane. `normal` faces the side the ray comes from and
 * `eta` is the ratio of indices, incident over transmitted.
 *
 * Reports invalid on total internal reflection, which is a real outcome here
 * rather than an error: a ray that enters the prism too straight-on meets the
 * second face past the critical angle and bounces instead of leaving.
 */
export fn refractRay(incident: vec2f, normal: vec2f, eta: f32) -> Refraction {
  let cosIncident = -dot(incident, normal);
  let sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);
  if (sinTransmittedSquared > 1.0) {
    return Refraction(false, vec2f(0.0));
  }
  let cosTransmitted = sqrt(1.0 - sinTransmittedSquared);
  return Refraction(true, incident * eta + normal * (eta * cosIncident - cosTransmitted));
}

/**
 * Refract a ray through the prism and return the ray that comes out the far side.
 *
 * `origin` is outside the glass and `direction` points into it. The ray
 * refracts on entry, crosses the interior, and refracts again on exit; when the
 * exit face reflects it instead (total internal reflection) it keeps bouncing
 * inside until it escapes or runs out of bounces.
 */
export fn tracePrism(
  prism: Prism,
  origin: vec2f,
  direction: vec2f,
  ior: f32,
  maxBounces: u32,
) -> PrismPath {
  let miss = PrismPath(false, vec2f(0.0), vec2f(0.0), 0u);
  let entry = intersectTriangle(prism, origin, direction, surfaceEpsilon);
  // A ray that first meets the boundary from behind started inside the glass.
  if (!entry.hit || dot(direction, entry.normal) >= 0.0) {
    return miss;
  }
  var position = origin + direction * entry.t;
  let entered = refractRay(direction, entry.normal, 1.0 / ior);
  if (!entered.valid) {
    return miss;
  }
  var inside = entered.direction;
  for (var bounces = 0u; bounces <= maxBounces; bounces = bounces + 1u) {
    let exit = intersectTriangle(prism, position, inside, surfaceEpsilon);
    if (!exit.hit) {
      return miss;
    }
    position = position + inside * exit.t;
    let transmitted = refractRay(inside, -exit.normal, ior);
    if (transmitted.valid) {
      return PrismPath(true, position, normalize(transmitted.direction), bounces);
    }
    inside = reflect(inside, exit.normal);
  }
  return miss;
}

/** Smooth angular falloff for a ray arriving at the lamp from `towardsScene`. */
export fn spotProfile(lamp: Lamp, towardsScene: vec2f) -> f32 {
  let angle = acos(clamp(dot(lamp.direction, towardsScene), 0.0, 1.0));
  return 1.0 - smoothstep(lamp.innerAngle, lamp.outerAngle, angle);
}

/**
 * How strongly a ray leaving the prism lands on the lamp.
 *
 * The emitter is a disc, so instead of a binary hit test this measures how
 * close the ray passes to its center and falls off smoothly across the radius.
 * That is the same estimator a hard hit test converges to, minus most of the
 * variance — a soft kernel turns a rare binary event into a value almost every
 * sample can contribute to.
 */
export fn lightConnection(lamp: Lamp, origin: vec2f, direction: vec2f) -> f32 {
  let towardsLight = lamp.center - origin;
  let along = dot(towardsLight, direction);
  if (along <= 0.0) {
    return 0.0;
  }
  let closest = length(towardsLight - direction * along);
  let kernel = 1.0 - smoothstep(0.0, lamp.radius, closest);
  if (kernel <= 0.0) {
    return 0.0;
  }
  return kernel * spotProfile(lamp, -direction);
}

/**
 * Analytic approximations of the CIE 1931 color matching functions.
 * Wyman, Sloan and Shirley, JCGT 2013.
 */
fn cieX(wavelengthNm: f32) -> f32 {
  let t1 = (wavelengthNm - 442.0) * select(0.0374, 0.0624, wavelengthNm < 442.0);
  let t2 = (wavelengthNm - 599.8) * select(0.0323, 0.0264, wavelengthNm < 599.8);
  let t3 = (wavelengthNm - 501.1) * select(0.0382, 0.0490, wavelengthNm < 501.1);
  return 0.362 * exp(-0.5 * t1 * t1) + 1.056 * exp(-0.5 * t2 * t2) - 0.065 * exp(-0.5 * t3 * t3);
}

fn cieY(wavelengthNm: f32) -> f32 {
  let t1 = (wavelengthNm - 568.8) * select(0.0247, 0.0213, wavelengthNm < 568.8);
  let t2 = (wavelengthNm - 530.9) * select(0.0322, 0.0613, wavelengthNm < 530.9);
  return 0.821 * exp(-0.5 * t1 * t1) + 0.286 * exp(-0.5 * t2 * t2);
}

fn cieZ(wavelengthNm: f32) -> f32 {
  let t1 = (wavelengthNm - 437.0) * select(0.0278, 0.0845, wavelengthNm < 437.0);
  let t2 = (wavelengthNm - 459.0) * select(0.0725, 0.0385, wavelengthNm < 459.0);
  return 1.217 * exp(-0.5 * t1 * t1) + 0.681 * exp(-0.5 * t2 * t2);
}

/**
 * Linear sRGB for a single wavelength.
 *
 * Spectral colors sit outside the sRGB gamut, so the matrix product goes
 * negative in one channel for most of the spectrum; clamping is the standard
 * approximation and keeps hue ordering intact.
 */
export fn wavelengthToLinearRgb(wavelengthNm: f32) -> vec3f {
  let xyz = vec3f(cieX(wavelengthNm), cieY(wavelengthNm), cieZ(wavelengthNm));
  let rgb = vec3f(
    dot(vec3f(3.2406, -1.5372, -0.4986), xyz),
    dot(vec3f(-0.9689, 1.8758, 0.0415), xyz),
    dot(vec3f(0.0557, -0.2040, 1.0570), xyz),
  );
  return max(rgb, vec3f(0.0));
}

/**
 * One ray of the estimator: aim at a point on the prism's face, refract
 * through, and weigh whatever comes out the other side by how well it lands on
 * the lamp.
 *
 * The 1/r term keeps a two-dimensional beam's energy constant as it spreads, so
 * the fan dims with distance from the glass the way the real one does.
 */
export fn traceRayWeight(
  prism: Prism,
  lamp: Lamp,
  point: vec2f,
  aim: vec2f,
  ior: f32,
  maxBounces: u32,
) -> f32 {
  let toAim = aim - point;
  let distance = length(toAim);
  if (distance <= surfaceEpsilon) {
    return 0.0;
  }
  let path = tracePrism(prism, point, toAim / distance, ior, maxBounces);
  if (!path.valid) {
    return 0.0;
  }
  return lightConnection(lamp, path.origin, path.direction) / (0.35 + distance);
}

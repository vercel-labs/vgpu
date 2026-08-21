// GEODESIC TRACER — the null-geodesic integrator, shared by the two one-shot
// passes that need it.
//
// INFRASTRUCTURE MODULE — read it, do not edit it. Like `gbuffer.wgsl` it is a
// pure WGSL module: no @group/@binding, only exported constants, structs and
// functions. The entry shaders (`bake.wgsl`, `refine.wgsl`) own their bindings
// and pass everything in.
//
// It exists because the ANTIALIASING refine pass has to trace sub-pixel rays
// with *exactly* the integrator the G-buffer was baked with. A second copy of
// the Verlet loop would drift the moment either file was tuned, and the whole
// premise of the AA data (coverage and span of the same ray bundle) depends on
// the sub-rays and the centre ray coming from one program. The extraction was
// verbatim and is gated on byte-identical debug renders; see gbuffer.md.
//
// Everything here is a one-shot cost: nothing in this file runs per frame.

/** Event horizon radius. The whole scene uses r_s = 1 units. */
export const HORIZON: f32 = 1.0;
/** Innermost stable circular orbit = inner edge of the accretion disk. */
export const ISCO: f32 = 3.0;
/** Integration budget per ray. Affordable because the bake is one-shot. */
export const MAX_STEPS: i32 = 768;

/**
 * One traced ray, in the raw form `bake.wgsl` writes to the G-buffer.
 *
 * `hitCount` is the number of recorded crossings of the [ISCO, diskOuter]
 * annulus (0, 1 or 2, nearest first). `swallowed` / `escaped` are 0 or 1 and are
 * NOT yet folded: the caller decides what an out-of-steps ray means (the bake
 * folds it into the shadow — see the comment at the end of `bake.wgsl`).
 */
export struct TraceResult {
  hit1Plane: vec2f,
  hit1Direction: vec2f,
  hit2Plane: vec2f,
  hit2Direction: vec2f,
  hitCount: i32,
  swallowed: f32,
  escaped: f32,
  /** Direction the ray is travelling when the loop ends; the sky lookup. */
  finalVelocity: vec3f,
}

/** A camera ray for one point on the screen, in world space. */
export struct CameraRay {
  position: vec3f,
  velocity: vec3f,
}

/**
 * Where a ray is declared to have reached infinity. Pushed out from 30 to
 * 120 r_s: the deflection is already converged at 30 (raising it to 120 moves
 * the outgoing direction by 0.002 deg at b = 3), but the far field is where the
 * adaptive step below buys its budget back, so a farther cutoff costs almost no
 * extra steps and makes the direction unambiguously asymptotic.
 */
export fn escapeRadiusFor(orbitRadius: f32) -> f32 {
  return max(120.0, orbitRadius + 8.0);
}

/**
 * Packs a unit direction into 2 floats: y, plus the azimuth of the xz part.
 * Lossless enough that f16 storage beats the old 3x f16 cartesian form, and it
 * keeps the sign of y exact, which is what `side` is reconstructed from.
 */
export fn encodeDirection(direction: vec3f) -> vec2f {
  return vec2f(direction.y, atan2(direction.z, direction.x));
}

fn geodesicAcceleration(position: vec3f, velocity: vec3f) -> vec3f {
  let r2 = max(dot(position, position), 0.0001);
  let angularMomentum = cross(position, velocity);
  let h2 = dot(angularMomentum, angularMomentum);
  return -1.5 * h2 * position / (r2 * r2 * sqrt(r2));
}

/**
 * Screen point -> world camera ray. `uv` is the fullscreen-quad coordinate,
 * (0,0) at the TOP-LEFT of the target.
 *
 * Both one-shot passes call this, and the refine pass calls it with SUB-PIXEL
 * offsets, which is the whole reason it is a function: the sub-rays have to come
 * out of the same NDC/basis arithmetic as the centre ray or the measured
 * coverage would be of a slightly different ray bundle than the G-buffer's.
 */
export fn cameraRay(
  uv: vec2f,
  resolution: vec2f,
  yaw: f32,
  pitch: f32,
  orbitRadius: f32,
  fov: f32,
  centerX: f32,
  centerY: f32,
  roll: f32,
) -> CameraRay {
  let aspect = resolution.x / max(resolution.y, 1.0);
  // ORIENTATION — vgpu's generated fullscreen vertex shader emits uv (0,0) at the
  // TOP-LEFT of the target and (1,1) at the bottom-right (the WebGPU texture
  // convention). Camera space is +Y up, so uv.y MUST be flipped here; feeding
  // `uv.y * 2 - 1` straight into `up` renders the whole scene upside down.
  // Every other pass is a 1:1 pass-through (shade textureLoads uv*dims), so this
  // is the single place the convention is converted, and it fixes the browser
  // and the node harness at once. See gbuffer.md.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  // Shift first so the roll pivots around the black hole rather than the centre
  // of the viewport. This makes off-axis close-ups behave like a real camera.
  // Correct horizontal screen distance before rotating. A roll in raw NDC
  // would rotate a 16:9 rectangle as though it were square and turn the
  // circular shadow into an ellipse.
  let screenPlane = (ndc - vec2f(centerX, centerY)) * vec2f(aspect, 1.0);
  let cosine = cos(roll);
  let sine = sin(roll);
  let screen = vec2f(
    screenPlane.x * cosine - screenPlane.y * sine,
    screenPlane.x * sine + screenPlane.y * cosine,
  );

  let clampedPitch = clamp(pitch, -1.319, 1.319);
  let cameraPosition = vec3f(
    sin(yaw) * cos(clampedPitch) * orbitRadius,
    sin(clampedPitch) * orbitRadius,
    cos(yaw) * cos(clampedPitch) * orbitRadius,
  );
  let forward = normalize(vec3f(0.0) - cameraPosition);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);

  var ray: CameraRay;
  ray.position = cameraPosition;
  ray.velocity = normalize(forward * fov + right * screen.x + up * screen.y);
  return ray;
}

/**
 * Integrates one null geodesic and records the first two crossings of the
 * [ISCO, diskOuter] annulus.
 *
 * `escapeRadius` is passed in rather than derived from `|position|` so the
 * caller's exact float value is used — this function must be bit-for-bit the
 * loop that produced the shipped G-buffer.
 *
 * The ray is NOT terminated at a disk hit: it keeps marching, so the final
 * velocity describes what is *behind* both disk layers, which is what lets the
 * disk shader be semi-transparent and let stars bleed through its fringes.
 */
export fn traceRay(cameraPosition: vec3f, initialVelocity: vec3f, diskOuter: f32, escapeRadius: f32) -> TraceResult {
  var position = cameraPosition;
  var velocity = initialVelocity;

  var result: TraceResult;
  result.hit1Plane = vec2f(0.0);
  result.hit1Direction = vec2f(0.0);
  result.hit2Plane = vec2f(0.0);
  result.hit2Direction = vec2f(0.0);
  result.hitCount = 0;
  result.swallowed = 0.0;
  result.escaped = 0.0;

  for (var stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
    let radius = length(position);
    if (radius < HORIZON * 1.004) {
      result.swallowed = 1.0;
      break;
    }
    if (radius > escapeRadius && dot(position, velocity) > 0.0) {
      result.escaped = 1.0;
      break;
    }

    // Adaptive to gravity: finer near the horizon where the geodesic curves
    // hardest. Much finer than the live version could afford (one-shot cost).
    //
    // The ceiling grows LINEARLY with radius past r = 6 instead of staying
    // pinned at 0.075. The acceleration falls off as h^2 / r^5, so out there a
    // 0.075 step resolves a straight line 20x more finely than needed and the
    // fixed cap was burning ~20% of MAX_STEPS on the flight in and out. Inside
    // r = 6 the factor is exactly 1, so the strong-field part of every geodesic
    // — everything that produces the deflection, the shadow edge and the disk
    // crossings — integrates bit-for-bit as before. Measured effect of the
    // relaxation (evidence/geo3.mjs): deflection unchanged to <= 0.03 deg, and
    // the freed budget shrinks the out-of-steps band from 8.6 px to 2.3 px at
    // 720p.
    let stepSize = clamp((radius - HORIZON) * 0.035, 0.0045, 0.075 * max(1.0, radius / 6.0));

    let previousPosition = position;
    let previousVelocity = velocity;

    // Velocity-Verlet style integration of the light geodesic.
    let acceleration0 = geodesicAcceleration(position, velocity);
    velocity += acceleration0 * (0.5 * stepSize);
    position += velocity * stepSize;
    let acceleration1 = geodesicAcceleration(position, velocity);
    velocity += acceleration1 * (0.5 * stepSize);
    velocity = normalize(velocity);

    // Hard disk: exact intersection with the y=0 annulus. No slab, no volume,
    // no oversampling heuristics -> no concentric ring aliasing either.
    //
    // The crossing test is a strict side change rather than `prevY * y <= 0`:
    // now that two hits are recorded, a step that lands exactly on y = 0 would
    // otherwise satisfy the product test twice and register the same crossing
    // as both hits. Folding y == 0 into the positive side makes every sign flip
    // fire exactly once, and keeps the interpolation denominator non-zero.
    if (result.hitCount < 2) {
      let previousSide = select(-1.0, 1.0, previousPosition.y >= 0.0);
      let currentSide = select(-1.0, 1.0, position.y >= 0.0);
      if (previousSide != currentSide) {
        let t = clamp(previousPosition.y / (previousPosition.y - position.y), 0.0, 1.0);
        let crossing = mix(previousPosition, position, t);
        let planeRadius = length(crossing.xz);
        if (planeRadius >= ISCO && planeRadius <= diskOuter) {
          let direction = encodeDirection(normalize(mix(previousVelocity, velocity, t)));
          if (result.hitCount == 0) {
            result.hit1Plane = crossing.xz;
            result.hit1Direction = direction;
          } else {
            result.hit2Plane = crossing.xz;
            result.hit2Direction = direction;
          }
          result.hitCount += 1;
        }
      }
    }
  }

  result.finalVelocity = velocity;
  return result;
}

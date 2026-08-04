// Shared G-buffer contract for the hero black hole.
//
// INFRASTRUCTURE MODULE — read it, do not edit it. `disk.wgsl` and `stars.wgsl`
// are the files meant to be iterated on. See gbuffer.md for the full contract.
//
// WGSL modules must stay pure: no @group/@binding here (the entry shader
// `shade.wgsl` owns every binding), only exported constants, structs and
// functions.

/** Event horizon radius. The whole scene uses r_s = 1 units. */
export const HORIZON: f32 = 1.0;
/** Innermost stable circular orbit = inner edge of the accretion disk. */
export const ISCO: f32 = 3.0;
export const TAU: f32 = 6.28318530718;
export const PI_CONST: f32 = 3.14159265359;

/**
 * One decoded G-buffer texel, for ONE disk layer. Produced by `decodeGBuffer()`
 * in the frame pass and handed to the disk / star shaders.
 *
 * Its shape is deliberately unchanged from the single-hit version: `shadeDisk`
 * shades one layer at a time and does not need to know whether it is looking at
 * the front crossing or the one hidden behind it.
 */
export struct GBufferSample {
  /** World-space position of the disk hit; y is always 0. Zero when `isHit` is false. */
  position: vec3f,
  /** Surface normal at the hit: (0, +1, 0) hit from above, (0, -1, 0) from below, 0 when no hit. */
  normal: vec3f,
  /** Normalized disk coordinates: x = radius 0 at ISCO -> 1 at the outer rim, y = azimuth 0..1. */
  diskUv: vec2f,
  /** Polar disk coordinates: x = world radius (>= ISCO), y = azimuth in radians (-PI..PI). */
  diskPolar: vec2f,
  /** Final ray direction after lensing (unit). Use it to sample the sky. */
  rayDirection: vec3f,
  /** Ray direction at the moment it hit the disk (unit). Use it for Doppler beaming. */
  viewDirection: vec3f,
  /** +1 hit from above, -1 from below, 0 no hit. Same sign as `normal.y`. */
  side: f32,
  /**
   * Fraction of the pixel this crossing actually covers, 0..1, measured by the
   * refine pass (`refine.wgsl`) with 16 sub-rays. `1` everywhere outside the
   * ~2% compressed band, and `1` on the back layer, which is not refined.
   *
   * It is a FRACTIONAL AREA: multiply `alpha` by it, never the colour — the
   * radiance of the covered part does not change because the part is small.
   */
  coverage: f32,
  /**
   * How much DISK RADIUS this pixel spans at this crossing, in normalized
   * annulus units (the same scale as `diskUv.x`), and centred on `diskPolar.x`:
   * the crossing radii of the pixel's ray bundle all lie inside
   * `diskPolar.x +/- span/2 * (diskOuter - ISCO)`.
   *
   * `0` outside the band. Where it is large the pixel is a radial AVERAGE of the
   * disk, not a sample of it, which is what `sampleAtRadius` + a tap loop in the
   * frame pass turn it into.
   */
  span: f32,
  /** True when this pixel sees the accretion disk. */
  isHit: bool,
  /**
   * True when this crossing did NOT come from the G-buffer: the pixel's centre
   * ray missed the disk, the refine pass's sub-rays did not, and this sample is
   * the surviving sub-ray nearest the pixel centre (see refine.wgsl).
   *
   * These are the sub-pixel arcs of the lensed disk image that live INSIDE the
   * shadow silhouette, where no centre ray of the neighbourhood sees the disk at
   * all. `coverage` is always < 1 on them, by construction. Nothing in the
   * shading needs to branch on this — it is a real crossing of a real geodesic —
   * it exists for debug view 9 and for the A/B: at `Shade.aa = 0` the frame pass
   * passes a zero `aaGeom` and no sample is ever synthesized.
   */
  synthesized: bool,
  /** True when the ray ended inside the event horizon (render black). */
  isBlackHole: bool,
  /** True when the ray escaped to infinity (render stars). */
  escaped: bool,
}

/**
 * The two disk crossings a single geodesic can record, nearest first.
 *
 * `front` is the crossing closest to the camera — the band that visually sits in
 * front. `back` is the next crossing along the same ray: the lensed image of the
 * disk that the front band partly hides. `back.isHit` is only ever true when
 * `front.isHit` is, so composite it *under* the front layer.
 *
 * Everything that is a property of the ray rather than of a crossing
 * (`rayDirection`, `isBlackHole`, `escaped`) is duplicated into both layers.
 */
export struct GBufferLayers {
  front: GBufferSample,
  back: GBufferSample,
}

/**
 * Unpacks a unit direction stored as (y, azimuth of xz) by bake.wgsl.
 * Reconstruction is exactly unit-length, which matters because disk.wgsl feeds
 * it straight into a dot product for the Doppler term.
 */
fn decodeDirection(encoded: vec2f) -> vec3f {
  let horizontal = sqrt(max(1.0 - encoded.x * encoded.x, 0.0));
  return vec3f(cos(encoded.y) * horizontal, encoded.x, sin(encoded.y) * horizontal);
}

/** Decodes one crossing. `flags` and `sky` are shared by both layers. */
fn decodeLayer(plane: vec2f, encodedDirection: vec2f, sky: vec4f, flags: i32, diskOuter: f32, aa: vec2f, synthesized: bool) -> GBufferSample {
  var sample: GBufferSample;
  let planeRadius = length(plane);
  // The bake only ever writes crossings inside [ISCO, diskOuter] and leaves a
  // plain (0, 0) otherwise, so the radius alone separates hit from miss and no
  // flag channel has to be spent on it.
  let isHit = planeRadius > ISCO * 0.5;
  let radius = max(planeRadius, ISCO);
  let azimuth = atan2(plane.y, plane.x);
  let direction = decodeDirection(encodedDirection);
  // Which face the photon sees. A photon that lands on the TOP face is by
  // definition travelling downward, so the side is just -sign(dir.y) and the
  // bake does not need to store it. select() keeps it strictly +/-1 so a
  // perfectly tangent ray cannot produce a 0 that would read as "no hit".
  let side = select(1.0, -1.0, direction.y > 0.0);

  sample.position = select(vec3f(0.0), vec3f(plane.x, 0.0, plane.y), isHit);
  sample.normal = select(vec3f(0.0), vec3f(0.0, side, 0.0), isHit);
  // Radial coordinate recomputed from the f32 hit position instead of being
  // stored: same formula the bake used, one fewer channel, and slightly more
  // accurate than the f16 copy it replaces.
  sample.diskUv = vec2f(
    clamp((radius - ISCO) / max(diskOuter - ISCO, 0.001), 0.0, 1.0),
    (azimuth + PI_CONST) / TAU,
  );
  sample.diskPolar = vec2f(radius, azimuth);
  sample.rayDirection = sky.xyz;
  sample.viewDirection = direction;
  sample.side = select(0.0, side, isHit);
  sample.coverage = clamp(aa.x, 0.0, 1.0);
  sample.span = clamp(aa.y, 0.0, 1.0);
  sample.isHit = isHit;
  sample.synthesized = synthesized && isHit;
  sample.isBlackHole = (flags & 1) != 0;
  sample.escaped = (flags & 2) != 0;
  return sample;
}

/**
 * Decodes the four raw G-buffer texels written by `bake.wgsl` into both disk
 * layers. `diskOuter` must be the same disk radius the bake ran with.
 *
 * `aa` is the matching texel of the refine pass's first attachment — `(covFront,
 * spanFront)`, see refine.wgsl. It describes the FRONT crossing only: the back
 * layer is handed `(1, 0)`, i.e. "fully covered, not compressed", so it decodes
 * exactly as it did before the AA target existed. Pass `vec2f(1.0, 0.0)` to opt
 * out entirely.
 *
 * `aaGeom` is the second attachment — a SYNTHESIZED front crossing for pixels
 * whose centre ray missed the disk while the refine pass's sub-rays hit it:
 * `xy` = plane position, `zw` = the encoded direction, in exactly the encoding
 * `hit1` / `view.xy` use. It is `(0,0,0,0)` on every pixel that has a real centre
 * hit and on every pixel outside the refined band, and `|xy| < ISCO` is the "no
 * substitution" test — the same one that separates hit from miss above. Pass
 * `vec4f(0.0)` to opt out entirely (that is what `Shade.aa = 0` does, which is
 * why the A/B switch is exact).
 *
 * Substituting here rather than in `shade.wgsl` is deliberate: the synthesized
 * sample is a real crossing of a real geodesic in the same encoding, so once it
 * is in place NOTHING downstream — footprints, rotation, the tap loop, the disk
 * shader — has to know it came from the refine pass.
 */
export fn decodeGBuffer(hit1: vec2f, hit2: vec2f, sky: vec4f, view: vec4f, diskOuter: f32, aa: vec2f, aaGeom: vec4f) -> GBufferLayers {
  let flags = i32(sky.w + 0.5);
  // The synthesized crossing only ever replaces a MISS: a pixel with a real
  // centre hit keeps the G-buffer's f32 position and exact direction.
  let substitute = length(hit1) <= ISCO * 0.5 && length(aaGeom.xy) > ISCO * 0.5;
  let frontPlane = select(hit1, aaGeom.xy, substitute);
  let frontDirection = select(view.xy, aaGeom.zw, substitute);
  var layers: GBufferLayers;
  layers.front = decodeLayer(frontPlane, frontDirection, sky, flags, diskOuter, aa, substitute);
  layers.back = decodeLayer(hit2, view.zw, sky, flags, diskOuter, vec2f(1.0, 0.0), false);
  // The bake already guarantees this ordering; enforcing it here too means a
  // second layer can never be shaded without a first one in front of it.
  if (!layers.front.isHit) {
    layers.back.isHit = false;
    layers.back.side = 0.0;
    layers.back.normal = vec3f(0.0);
  }
  return layers;
}

/**
 * The same crossing, moved to a different DISK RADIUS at the same azimuth.
 *
 * This is the tap generator for the frame pass's radial prefilter: where the
 * refine pass measured a large `span`, one pixel covers a wide range of disk
 * radii, and the honest value for it is the MEAN of `shadeDisk` over that range
 * rather than a point sample at whichever radius the centre ray happened to hit.
 * `shade.wgsl` calls this K times and averages; `disk.wgsl` never learns that it
 * is being oversampled, which is what keeps the look's ownership intact.
 *
 * Only the radial coordinates move. Azimuth, view direction, normal, side and
 * the flags are properties of the ray bundle and the axisymmetric geometry, so
 * they are shared by every tap — and because they are, this is exact under
 * `sceneYaw`: it commutes with `rotateSample`.
 *
 * The position is rebuilt from (radius, azimuth) rather than scaled, so it stays
 * consistent with `diskPolar` after a rotation to within float rounding of the
 * cos/sin pair the rotation itself used.
 */
export fn sampleAtRadius(g: GBufferSample, radius: f32, diskOuter: f32) -> GBufferSample {
  var moved = g;
  let clamped = clamp(radius, ISCO, max(diskOuter, ISCO));
  let azimuth = g.diskPolar.y;
  moved.position = vec3f(cos(azimuth) * clamped, 0.0, sin(azimuth) * clamped);
  moved.diskPolar = vec2f(clamped, azimuth);
  moved.diskUv = vec2f(
    clamp((clamped - ISCO) / max(diskOuter - ISCO, 0.001), 0.0, 1.0),
    g.diskUv.y,
  );
  return moved;
}

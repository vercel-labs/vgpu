// REFINE PASS — one-shot sub-pixel coverage/span/geometry of the photon ring.
//
// Runs immediately after the bake, in the same throttled `if (bake)` block, and
// never per frame. Reads the G-buffer the bake just wrote, finds the ~2% of
// pixels where the lensed disk image is compressed below one pixel, and traces
// 16 sub-rays there with the SAME integrator (`geodesic.wgsl`) to measure what
// the per-frame pass cannot recover on its own:
//
//   covFront  fraction of the pixel covered by the FIRST disk crossing;
//   spanFront how much DISK RADIUS the pixel spans at that crossing;
//   geometry  the crossing itself (plane position + direction) for pixels whose
//             CENTRE ray missed the disk while the sub-rays found it — the
//             sub-pixel arcs that live inside the shadow silhouette. Coverage can
//             only scale a sample that exists; this is that sample.
//
// WHY THIS PASS EXISTS. At the shipped defaults the whole [ISCO, diskOuter]
// annulus is squeezed into ~1.5 px at screen radius r ~ 190 px (720p): measured
// on debug view 2, `diskUv.x` goes 0.12 -> 0.71 between two ADJACENT pixels at
// constant azimuth. One ray per pixel therefore draws a random radius out of the
// whole annulus, and every analytic softness in disk.wgsl (`innerEdge`,
// `outerEdge`, `flux`) is soft in DISK space and a hard step in SCREEN space
// there. The result is a dotted 1 px wire whose brightness jitters 10x between
// neighbouring degrees of azimuth, and a frame that is missing ~24% of the light
// a 3x supersampled reference collects. See gbuffer.md, "AA target".
//
// WHY IT IS A SEPARATE PASS AND A SEPARATE TARGET. The bake's MRT already spends
// exactly 32 B/sample, which is all WebGPU guarantees
// (`maxColorAttachmentBytesPerSample`), so a 5th attachment is not available. A
// second pass with its own two small attachments (2 B/px `rg8unorm` coverage/span
// + 8 B/px `rgba16float` crossing geometry = 10 of a fresh 32 B budget) is
// additive, deletable, and costs the frame pass two texel fetches.
//
// COST. One-shot, and amortised the same way the bake is (the 200 ms re-bake
// throttle, renderer.ts). 25 texel loads per pixel for the mask, plus 16
// geodesics on the ~2% of pixels that fail it. The refined pixels are the
// EXPENSIVE near-b_crit geodesics, so the pass is roughly a third of the bake in
// practice; if a geometry drag ever feels sticky, cut SUB_STEPS 4 -> 3 (9
// sub-rays) before touching MAX_STEPS — a 2x reference is already close to a 3x
// one, so 16 sub-rays is more than converged.

import { HORIZON, ISCO, cameraRay, encodeDirection, escapeRadiusFor, traceRay } from "./geodesic.wgsl";

/**
 * Same fields as `Bake` in bake.wgsl, in the same order: `renderer.ts` uploads
 * one geometry description to both passes, so they can never disagree about the
 * camera the sub-rays are traced from.
 */
struct Refine {
  resolution: vec2f,
  yaw: f32,
  pitch: f32,
  orbitRadius: f32,
  diskOuter: f32,
  fov: f32,
  centerX: f32,
  centerY: f32,
  roll: f32,
}

@group(0) @binding(0) var<uniform> refine: Refine;
/** First-crossing plane position, from the bake pass. `(0,0)` = no hit. */
@group(0) @binding(1) var gHit1: texture_2d<f32>;
/** Only `w` is read here: flag bit 0 = the ray ended in the shadow. */
@group(0) @binding(2) var gSky: texture_2d<f32>;

/** Sub-rays per axis inside one pixel: 4x4 = 16 samples. */
const SUB_STEPS: i32 = 4;
/**
 * Half-width of the neighbourhood the boundary test looks at, in pixels.
 *
 * 5x5 (radius 2), not 3x3: the ring is thinner than a pixel, so a pixel whose
 * CENTRE ray misses it entirely must still be refined or it stays a hole in the
 * wire. Dilating the mask by 2 px is cheap one-shot insurance (25 loads).
 */
const MASK_RADIUS: i32 = 2;
/**
 * Radial-gradient trigger, in normalized annulus units. A pixel whose neighbour
 * sits 12% of the annulus away at the same azimuth is already in the compressed
 * regime even if both of them hit, which is the case coverage alone would miss.
 */
const GRADIENT_LIMIT: f32 = 0.12;
/**
 * Critical impact parameter of a Schwarzschild photon, `3 * sqrt(3) / 2 * r_s`,
 * in the r_s = 1 units the whole scene uses (`HORIZON` = 1).
 *
 * `b = |r x v|` is the ray's conserved L/E, so `b < B_CRIT` is EXACTLY the
 * capture condition — it is the silhouette, analytically, with no dependence on
 * the camera. Verified against the integrator in
 * /home/user/reports/aa-dropout/bcrit.mjs: at the shipped defaults the numerical
 * capture boundary sits at b = 2.5914 and the out-of-steps band (which
 * `bake.wgsl` folds into the shadow) ends at b = 2.6179, i.e. both are inside
 * `B_CRIT +/- 0.02`.
 */
const B_CRIT: f32 = 2.59807621;
/**
 * Half-width, in impact parameter, of the NEAR-CRITICAL band that is refined
 * regardless of what the neighbourhood looks like.
 *
 * WHY THIS EXISTS. The neighbourhood tests above can only see what the CENTRE
 * rays saw. The lensed disk images formed by rays that wind past the photon
 * sphere are compressed by e^-pi per extra half turn, so they are far thinner
 * than a pixel and can live entirely between centre rays: a 5x5 neighbourhood in
 * which every ray is swallowed (all-shadow, no hit, no gradient) still hides an
 * arc, and no neighbourhood test of any width can see that.
 *
 * BE HONEST ABOUT WHAT IT BUYS TODAY: at the shipped 720p defaults this criterion
 * changes NOTHING in the final image. It flags 544 extra pixels, and all 544
 * differ from the pass-through only in the SPAN channel — coverage is identical
 * (measured: `cmp` of debug view 8 before/after differs on 544 px, G only, R and
 * B byte-identical). Zero new coverage means no sub-ray hit in those pixels,
 * which means no synthesized crossing and no shading change. Every arc actually
 * recovered at 720p sits in a neighbourhood the 5x5 test already flagged. The
 * criterion starts to contribute at higher resolution (measured: +244 px of new
 * coverage at 1920x1080, which is what the real browser runs — DPR 1 on a ~1500px
 * viewport) and under camera moves (+8 px at `--distance 9.0`), because the band
 * moves relative to the pixel grid. It is kept as the analytically correct
 * silhouette test — `b < B_CRIT` IS the capture condition — for one `cameraRay`
 * plus one cross product in a pass that runs once per rebake.
 *
 * A band in `b` rather than a wider pixel dilation because `b` is the physical
 * coordinate the arcs are thin in: it is exact under `sceneYaw`, and it keeps
 * covering the same arcs at any resolution, fov or camera distance, where "N
 * pixels of dilation" would not. 0.06 is ~4.5 px at the shipped 720p defaults
 * (db/dpx = 0.0133, measured), i.e. 3x the margin needed to contain the whole
 * [2.5914, 2.6179] window above, and it is a one-shot cost.
 */
const CRITICAL_BAND: f32 = 0.06;

/** The bake writes a plain (0,0) for "no crossing"; the annulus starts at ISCO. */
fn isHitAt(plane: vec2f) -> bool {
  return length(plane) > ISCO * 0.5;
}

/**
 * What the pass writes, in @location order.
 *
 * Two attachments instead of one because coverage can only ever SCALE a sample
 * that exists: a pixel whose centre ray missed the ring has no radius, azimuth or
 * view direction for the frame pass to rebuild a `GBufferSample` from, and
 * `covFront` alone leaves it black (the old "known gap"). `geometry` is that
 * missing crossing, in exactly the encoding `bake.wgsl` uses for `gHit1` /
 * `gView.xy`, so `decodeGBuffer` can substitute it with no new decode path.
 *
 * Byte cost of the pass: 2 + 8 = 10 of a fresh 32 B/sample budget.
 *
 * `rgba16float` and not `rgba8unorm` for the geometry, deliberately: 8-bit
 * azimuth quantizes to 2*pi/255 = 0.0246 rad, and along the ring the azimuth
 * moves ~0.005 rad per pixel, so a unorm8 azimuth would freeze the disk's noise
 * and Doppler pattern into ~5 px stairs along an arc that is 1 px wide — a new
 * artifact in the very band being fixed. Storing the crossing as an f16 PLANE
 * POSITION instead keeps 0.0039 world units at r ~ 6 (10-bit mantissa, exponent
 * 2), i.e. 6.5e-4 rad of azimuth (0.13 px) and 0.1% of the annulus in radius,
 * and it needs no new decode. The direction rides along in the same 8 bytes as
 * the (y, azimuth) pair `gView` already stores; the disk look reads it for the
 * slab path length, the face-on lift and the Doppler beaming, so a synthesized
 * sample without it would be shaded as if seen exactly edge-on (grazing pinned at
 * the 34x ceiling, no `arcLift`) — the one thing the arcs are not.
 */
struct RefineOut {
  /** x = covFront, y = spanFront. `rg8unorm`, 1.0 exact. */
  @location(0) coverage: vec2f,
  /**
   * SYNTHESIZED front crossing, `rgba16float`, and only for pixels whose centre
   * ray missed the disk while sub-rays hit it:
   *   xy = crossing position in the y = 0 plane (world x, z), (0,0) = none;
   *   zw = ray direction at that crossing, `encodeDirection`'d (y, azimuth).
   * All zero everywhere else, including on pixels that have a real centre hit —
   * those already have the real thing in the G-buffer.
   */
  @location(1) geometry: vec4f,
}

@fragment fn fs_main(@location(0) uv: vec2f) -> RefineOut {
  let dimensions = vec2i(textureDimensions(gHit1, 0));
  let texel = vec2i(clamp(uv * refine.resolution, vec2f(0.0), refine.resolution - vec2f(1.0)));
  let annulus = max(refine.diskOuter - ISCO, 0.001);

  let centerPlane = textureLoad(gHit1, texel, 0).xy;
  let centerHit = isHitAt(centerPlane);
  let centerHole = (i32(textureLoad(gSky, texel, 0).w + 0.5) & 1) != 0;
  let centerRadiusNorm = clamp((length(centerPlane) - ISCO) / annulus, 0.0, 1.0);

  // The pixel's own centre ray. Traced nowhere — only its conserved impact
  // parameter `b = |r x v|` is wanted, for the near-critical test below.
  let centerRay = cameraRay(
    uv,
    refine.resolution,
    refine.yaw,
    refine.pitch,
    refine.orbitRadius,
    refine.fov,
    refine.centerX,
    refine.centerY,
    refine.roll,
  );
  let impactParameter = length(cross(centerRay.position, centerRay.velocity));

  // --- band detection ---------------------------------------------------------
  // Mixed state in the 5x5 neighbourhood: a different hit/miss answer, a
  // different shadow flag, or a steep radial gradient. Any of the three means
  // the pixel's ray bundle straddles something the single centre ray cannot
  // describe.
  //
  // ...OR the ray is near-critical, whatever its neighbours say. The
  // neighbourhood tests are blind to an image thinner than the gap between two
  // centre rays, and every extra half turn around the photon sphere compresses
  // one by e^-pi, so the arcs closest to the silhouette live BETWEEN the centre
  // rays of an otherwise uniform, all-shadow 5x5 block. `b` is the coordinate
  // they are thin in, so the band is defined there (see `CRITICAL_BAND`).
  var boundary = abs(impactParameter - B_CRIT) < CRITICAL_BAND * HORIZON;
  for (var dy = -MASK_RADIUS; dy <= MASK_RADIUS; dy++) {
    for (var dx = -MASK_RADIUS; dx <= MASK_RADIUS; dx++) {
      let neighbor = clamp(texel + vec2i(dx, dy), vec2i(0), dimensions - vec2i(1));
      let plane = textureLoad(gHit1, neighbor, 0).xy;
      let hit = isHitAt(plane);
      let hole = (i32(textureLoad(gSky, neighbor, 0).w + 0.5) & 1) != 0;
      if (hit != centerHit || hole != centerHole) {
        boundary = true;
      }
      if (hit && centerHit) {
        let radiusNorm = clamp((length(plane) - ISCO) / annulus, 0.0, 1.0);
        if (abs(radiusNorm - centerRadiusNorm) > GRADIENT_LIMIT) {
          boundary = true;
        }
      }
    }
  }

  // Everything outside the band is exactly what it is today: full coverage on a
  // hit, none on a miss, and zero span so the frame pass takes its single-tap
  // path. `1.0` and `0.0` are both exact in rg8unorm, so a non-band pixel
  // multiplies its alpha by a literal 1 and stays bit-for-bit unchanged.
  if (!boundary) {
    return RefineOut(vec2f(select(0.0, 1.0, centerHit), 0.0), vec4f(0.0));
  }

  // --- 16 sub-rays ------------------------------------------------------------
  // A regular 4x4 stratified grid inside the pixel, deterministic and identical
  // for every pixel: a fixed pattern makes the residual quantisation of
  // `coverage` vary SMOOTHLY along the ring, which is the whole point of the
  // exercise, where a per-pixel jitter would trade a bias for pixel-to-pixel
  // noise in exactly the band being fixed.
  let escapeRadius = escapeRadiusFor(refine.orbitRadius);
  var hits = 0.0;
  var minRadius = 1e9;
  var maxRadius = -1e9;
  // The sub-ray that stands in for the centre ray when the centre ray itself
  // missed: the surviving sub-ray CLOSEST TO THE PIXEL CENTRE, kept whole — its
  // own plane position and its own direction, one real geodesic.
  //
  // Not an average of the sub-rays: averaging positions lies about the geometry
  // (gbuffer.md), and averaging DIRECTIONS is worse here, because sub-rays on
  // either side of a fold cross opposite faces of the disk and their `dir.y`
  // would cancel — the disk look reads `1/|dir.y|` as its slab path length, so a
  // cancelled y would shade the arc at the 34x edge-on ceiling. The nearest
  // surviving sample is the honest answer to "what would the centre ray have seen
  // had the arc been half a pixel wider", and it keeps position, azimuth and
  // direction mutually consistent because they come from ONE ray.
  var bestPlane = vec2f(0.0);
  var bestDirection = vec2f(0.0);
  var bestRadius = 0.0;
  var bestDistance = 1e9;
  // Shadow coverage is deliberately NOT accumulated: measured, the shadow/sky
  // step is 0 -> 4/255, i.e. invisible, and consuming a fractional shadow would
  // composite stars from the truncated `gSky.xyz` of a swallowed ray — new
  // speckle in a 1 px rim, plus a perturbed derivative field under the star
  // prefilter. If it is ever wanted, it needs an escaped sub-sample's DIRECTION
  // stored alongside it, and a third channel. See gbuffer.md.
  for (var sy = 0; sy < SUB_STEPS; sy++) {
    for (var sx = 0; sx < SUB_STEPS; sx++) {
      let offset = (vec2f(f32(sx), f32(sy)) + vec2f(0.5)) / f32(SUB_STEPS);
      let subUv = (vec2f(texel) + offset) / refine.resolution;
      let ray = cameraRay(
        subUv,
        refine.resolution,
        refine.yaw,
        refine.pitch,
        refine.orbitRadius,
        refine.fov,
        refine.centerX,
        refine.centerY,
        refine.roll,
      );
      let traced = traceRay(ray.position, ray.velocity, refine.diskOuter, escapeRadius);
      if (traced.hitCount > 0) {
        let radius = length(traced.hit1Plane);
        hits += 1.0;
        minRadius = min(minRadius, radius);
        maxRadius = max(maxRadius, radius);
        let distance = length(offset - vec2f(0.5));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPlane = traced.hit1Plane;
          // Already in `encodeDirection` form — `traceRay` stores it exactly as
          // `bake.wgsl` writes it into `gView.xy`, so this is the same encoding
          // `decodeGBuffer` reads on a real hit.
          bestDirection = traced.hit1Direction;
          bestRadius = radius;
        }
      }
    }
  }

  let coverage = hits / f32(SUB_STEPS * SUB_STEPS);
  if (hits < 0.5) {
    return RefineOut(vec2f(0.0, 0.0), vec4f(0.0));
  }

  // --- span, measured SYMMETRICALLY ABOUT THE CENTRE RAY ----------------------
  // The frame pass places its taps on [r0 - span/2, r0 + span/2], anchored at the
  // centre ray's own radius `r0`, because that is the only radius it has. So the
  // useful quantity is not (rmax - rmin) but the smallest interval CENTRED ON r0
  // that contains every sub-ray crossing: with (rmax - rmin), a centre ray
  // sitting at one end of the range would shift the whole tap set off the
  // measured span by up to half of it and bias the radial mean (the plan's
  // risk 2). The price is a span up to 2x wider than the raw range, i.e. a
  // slightly wider prefilter — never a fade, and never a shifted one.
  //
  // The SYNTHESIZED case is the one exception, and it is an exception because the
  // anchor is ours to choose: this pass decides which radius the frame pass will
  // put at the centre of its taps, so it picks the MIDPOINT of the measured range
  // and writes the raw range as the span. Anchoring a synthesized pixel at the
  // representative sub-ray's own radius instead, with the symmetric (2x) span,
  // measurably dilutes it — the tap loop then averages `shadeDisk` over radii no
  // sub-ray ever crossed, and at 720p/357 deg that came out at 25/255 against 51
  // in the 3x reference. Only the radial coordinate is moved to the midpoint; the
  // azimuth and the direction stay those of the nearest surviving sub-ray, i.e.
  // of one real geodesic.
  var r0 = length(centerPlane);
  var span = 0.0;
  var geometry = vec4f(0.0);
  if (centerHit) {
    span = 2.0 * max(abs(maxRadius - r0), abs(r0 - minRadius));
    // On a real centre hit the frame pass must keep using the G-buffer's f32
    // position and its exact direction — an f16 copy would be a silent,
    // pointless downgrade — so the attachment stays zero and `(0,0)` means
    // "nothing to substitute".
  } else {
    r0 = 0.5 * (minRadius + maxRadius);
    span = maxRadius - minRadius;
    geometry = vec4f(bestPlane * (r0 / max(bestRadius, ISCO)), bestDirection);
  }
  return RefineOut(vec2f(coverage, clamp(span / annulus, 0.0, 1.0)), geometry);
}

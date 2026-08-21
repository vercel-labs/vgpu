// FRAME PASS ENTRY — thin dispatcher, runs every frame into a linear-HDR scene
// target consumed by bloom.wgsl and composite.wgsl.
//
// INFRASTRUCTURE FILE — avoid editing it. It owns the bindings, decodes the
// G-buffer written by bake.wgsl, computes the noise footprints (derivatives need
// uniform control flow, so they cannot happen inside the disk branches) and
// composites, back to front:
//
//   stars.wgsl   (shadeStars, with the baked lensed direction) or black
//   disk.wgsl    (shadeDisk on the SECOND disk crossing — the hidden image)
//   disk.wgsl    (shadeDisk on the FIRST disk crossing — the front band)
//
// Tone mapping deliberately lives in composite.wgsl now: bloom has to see the
// unclamped radiance or the bright disk and a merely white pixel would contribute
// the same halo. G-buffer debug views remain raw and composite bypasses bloom and
// tone mapping whenever `debugView` is non-zero.
//
// No raymarching happens here: the geodesics were solved once by bake.wgsl.
// See gbuffer.md for the full contract.

import { GBufferSample, GBufferLayers, decodeGBuffer, sampleAtRadius, ISCO, PI_CONST, TAU } from "./gbuffer.wgsl";
import { DiskLook, DiskSample, shadeDisk, SHEAR_PERIOD } from "./disk.wgsl";
import { StarLook, shadeStars, starPrefilterRatio } from "./stars.wgsl";

struct Shade {
  resolution: vec2f,
  /** Seconds since start; the only animation clock. The camera never moves. */
  time: f32,
  /** Outer disk radius the G-buffer was baked with. */
  diskOuter: f32,
  /** 0 = final image, 1..9 = G-buffer debug views, 10 = content fade mask. */
  debugView: f32,
  /**
   * Photon-ring antialiasing: 1 consumes the refine pass's coverage/span target,
   * 0 ignores it completely.
   *
   * The A/B knob, and it is a real one: at 0 every pixel is shaded exactly as it
   * was before the AA target existed (`coverage` is forced to a literal 1 and the
   * tap loop is never entered), so the two settings differ only inside the ~2% of
   * pixels the refine pass flagged.
   */
  aa: f32,
  /** 1 = front disk crossing only, 2 = also composite the second crossing. */
  diskLayers: f32,
  /**
   * ACTIVE rotation of the whole scene around the Y axis, in radians.
   *
   * The camera is frozen by the bake and never moves; the scene (disk + lensed
   * sky) is rotated instead, which is exact because the geometry is
   * axisymmetric: Schwarzschild gravity plus a ring centered on `y = 0`. So the
   * baked G-buffer stays valid and a mouse move costs ONE uniform, never a bake.
   *
   * PRECONDITION: it stops being exact the moment anything breaks that symmetry
   * (a warped/tilted disk, an occluder, non-spherical gravity, world lighting
   * that does not rotate with the scene).
   *
   * Sign: rotating the scene by `+theta` is the same as rotating the camera by
   * `-theta` (`Bake.yaw` is camera yaw, opposite sign — hence the different
   * name). The frame pass therefore evaluates the baked samples in the inverse
   * frame: `R_y(-sceneYaw)`.
   */
  sceneYaw: f32,
  /** 1 applies the desktop content fade; 0 keeps the full scene visible. */
  sideFade: f32,
  /** 1 applies the mobile vertical fade around the centered HTML copy. */
  centerFade: f32,
}

/**
 * Angular size of the finest star layer in stars.wgsl (210 cells per cube face).
 * The sampling reference for the lensed sky: `skyFootprint` is reported in units
 * of it by debug view 6. Nothing in the final image keys off it any more — the
 * sky is prefiltered per layer inside stars.wgsl instead of being faded out by a
 * single global threshold.
 */
const STAR_CELL: f32 = 1.0 / 210.0;

/**
 * Extra weight on disk emission, carried over from the single-layer version
 * (which composited `mix(bg, S, a) + S*a*0.35`). Applied identically to both
 * layers so adding the second one does not change how bright the front band is.
 */
const DISK_GAIN: f32 = 1.35;

/** Matches the shared max width used by the navbar and hero HTML container. */
const CONTENT_MAX_WIDTH: f32 = 1448.0;
/** Matches the hero container's `px-6` horizontal padding. */
const CONTENT_PADDING: f32 = 24.0;

/**
 * Horizontal mask that lets the HTML copy own the left side of the hero.
 *
 * The ramp starts at the copy's actual left edge (centred max-width container
 * plus its padding), not at the viewport centre, and restores the unmodified
 * presentation at screen centre. The hero renders at DPR 1, so shader pixels
 * and CSS pixels share the same coordinate space.
 */
fn contentFade(uvX: f32, resolutionX: f32) -> f32 {
  let safeWidth = max(resolutionX, 1.0);
  let containerMargin = max((safeWidth - CONTENT_MAX_WIDTH) * 0.5, 0.0);
  let contentStart = min((containerMargin + CONTENT_PADDING) / safeWidth, 0.5);
  // The scene is linear HDR, while the layout decision is perceptual. Raising
  // the smooth ramp keeps more of its span dark instead of making the fade read
  // as an abrupt dimming only near the copy.
  return pow(smoothstep(contentStart, 0.5, uvX), 2.2);
}

/**
 * Mobile readability mask: black through the centered copy, restoring the
 * scene toward the top and bottom edges. The gamma-shaped ramp stays dark
 * across the tabs and snippet instead of recovering while they are still over
 * the bright accretion disk.
 */
fn centeredCopyFade(uvY: f32) -> f32 {
  let distanceFromCenter = abs(uvY - 0.5);
  return pow(smoothstep(0.08, 0.38, distanceFromCenter), 2.2);
}

@group(0) @binding(0) var<uniform> shade: Shade;
@group(0) @binding(1) var gHit1: texture_2d<f32>;
@group(0) @binding(2) var gHit2: texture_2d<f32>;
@group(0) @binding(3) var gSky: texture_2d<f32>;
@group(0) @binding(4) var gView: texture_2d<f32>;
@group(0) @binding(5) var<uniform> disk: DiskLook;
@group(0) @binding(6) var<uniform> stars: StarLook;
/**
 * Tiled 3D value-noise lattice for disk.wgsl, and its sampler.
 *
 * The disk's smoke used to hash its noise lattice inline, eight `hash31` calls
 * per sample and ~26 samples per pixel per layer. The lattice is now baked once
 * into an `r8unorm` `texture_3d` (`noise-volume.mjs`) and read with a single
 * trilinear fetch. They live HERE and not in disk.wgsl because WGSL modules in
 * this project never declare bindings — the entry shader owns the bind group
 * and passes resources down, exactly like `disk` and `stars` above.
 *
 * The sampler MUST be linear min/mag with `repeat` on all three axes: `noise3`
 * wraps the integer cell itself but relies on `repeat` to close the tile
 * between the last texel and the first.
 */
@group(0) @binding(7) var noiseVolume: texture_3d<f32>;
@group(0) @binding(8) var noiseSampler: sampler;
/**
 * Photon-ring AA data from the one-shot refine pass: `rg8unorm`, x = coverage of
 * the front crossing, y = the disk radius the pixel spans there (normalized
 * annulus units, centred on the pixel's own radius). See refine.wgsl.
 *
 * 2 B/px on top of the 32 B/px the G-buffer already costs this pass (the other
 * 8 are `gAaGeom` below), read with the same 1:1 `textureLoad` as everything else.
 * It is a separate target rather than a 5th bake attachment because the bake's MRT
 * already spends the full 32 B/sample WebGPU guarantees.
 */
@group(0) @binding(9) var gAa: texture_2d<f32>;
/**
 * Second attachment of the refine pass: a SYNTHESIZED front crossing
 * (`rgba16float`, xy = plane position, zw = encoded direction) for the pixels
 * whose centre ray missed the ring while the sub-rays found it — the sub-pixel
 * arcs inside the shadow silhouette. `(0,0,0,0)` everywhere else.
 *
 * Coverage can only SCALE a sample; this is the sample. 8 B/px more read on top
 * of the 32 B/px G-buffer and the 2 B/px coverage pair, one extra `textureLoad`,
 * and it is consumed exclusively through `decodeGBuffer` — see refine.wgsl for
 * why the crossing is stored as an f16 plane position instead of an 8-bit
 * (radius, azimuth) pair.
 */
@group(0) @binding(10) var gAaGeom: texture_2d<f32>;

/**
 * Screen-space footprint of the disk noise for one layer, in noise units per
 * pixel, SPLIT INTO ITS TWO AXES: `x` = the angular term (`disk.stretch` x the
 * azimuth a pixel covers), `y` = the radial term (`disk.detail` x the disk radius
 * a pixel covers).
 *
 * MUST be called from uniform control flow: it takes derivatives, which are
 * undefined inside the `isHit` branches, so both layers are measured for every
 * pixel and the results are only *used* on hits.
 *
 * The two axes are kept apart because the ring prefilter needs exactly one of
 * them. Inside the compressed band the radial term is enormous (the pixel spans
 * most of the annulus) and it is the term each TAP replaces with its own, much
 * narrower slice — while the angular term is the pixel's and stays the pixel's.
 * Collapsing them here first, and then handing the collapsed value to the taps,
 * would prefilter every tap over the whole span and flatten precisely the
 * emission crests the tap loop exists to average.
 */
fn diskFootprintAxes(g: GBufferSample) -> vec2f {
  let angular = max(disk.stretch, 0.05);
  let noiseAngle = g.diskPolar.y - min(shade.time, SHEAR_PERIOD * 0.5) * (disk.speed * 0.55 / pow(g.diskPolar.x, 1.5));
  let noiseCoords = vec3f(
    cos(noiseAngle) * angular,
    sin(noiseAngle) * angular,
    g.diskPolar.x * disk.detail,
  );
  return vec2f(
    max(fwidth(noiseCoords.x), fwidth(noiseCoords.y)),
    fwidth(noiseCoords.z),
  );
}

/**
 * The scalar `shadeDisk` takes: the wider of the two axes, capped. Unchanged —
 * this is bit-for-bit the value `diskFootprint` returned before it was split.
 */
fn diskFootprint(axes: vec2f) -> f32 {
  return min(max(axes.x, axes.y), 4.0);
}

/**
 * Active rotation around +Y: takes (0,0,r) to (sin(a)r, 0, cos(a)r), the exact
 * matrix the bake's camera yaw uses. Because the project defines the azimuth as
 * `atan2(z, x)`, it maps `azimuth -> azimuth - a`.
 */
fn rotateY(v: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

/** Wraps an angle back into (-PI, PI], the range `diskPolar.y` is contracted to. */
fn wrapAngle(angle: f32) -> f32 {
  return angle - TAU * floor((angle + PI_CONST) / TAU);
}

/**
 * Re-expresses one baked crossing in the rotated scene.
 *
 * The scene is rotated ACTIVELY by `shade.sceneYaw`, so a sample baked in world
 * space has to be evaluated in the inverse frame: every world vector goes
 * through `R_y(-sceneYaw)` (the minus is passed in by the caller, on purpose —
 * it is the whole sign convention and must stay visible).
 *
 * Position, view direction and ray direction rotate TOGETHER. Rotating only one
 * of them would slide the Doppler lobe or the sky against the disk; rotating all
 * of them keeps every dot product (Doppler beaming, edge-on foreshortening)
 * bit-for-bit equal to the unrotated scene, because the matrix is orthogonal.
 *
 * Invariant, and therefore untouched: the disk radius (`diskPolar.x`,
 * `diskUv.x`), the normal (0, +/-1, 0), `side`, and all three flags.
 */
fn rotateSample(g: GBufferSample, angle: f32) -> GBufferSample {
  var rotated = g;
  rotated.position = rotateY(g.position, angle);
  rotated.viewDirection = rotateY(g.viewDirection, angle);
  rotated.rayDirection = rotateY(g.rayDirection, angle);
  // Equivalent to atan2(rotated.position.z, rotated.position.x), but defined for
  // misses too (their position is exactly (0,0,0), where atan2 is not).
  let azimuth = wrapAngle(g.diskPolar.y - angle);
  rotated.diskPolar = vec2f(g.diskPolar.x, azimuth);
  rotated.diskUv = vec2f(g.diskUv.x, (azimuth + PI_CONST) / TAU);
  return rotated;
}

/** Both crossings, moved into the rotated scene by the same transform. */
fn rotateLayers(layers: GBufferLayers, angle: f32) -> GBufferLayers {
  var rotated: GBufferLayers;
  rotated.front = rotateSample(layers.front, angle);
  rotated.back = rotateSample(layers.back, angle);
  return rotated;
}

// --- Photon-ring radial prefilter --------------------------------------------
//
// The artifact this exists for is NOT a jaggy silhouette. At screen radius
// r ~ 190 px (720p) the whole [ISCO, diskOuter] annulus is compressed into
// ~1.5 px, so one ray per pixel draws a random disk radius out of the entire
// annulus: measured on debug view 2, `diskUv.x` jumps 0.12 -> 0.71 between two
// adjacent pixels. Every softness in disk.wgsl (`innerEdge`, `outerEdge`, `flux`)
// is soft in DISK space and therefore a hard step in SCREEN space there. The
// visible result is a dotted 1 px wire whose brightness jitters 10x between
// neighbouring degrees of azimuth (measured tangential profile: min 9, max 112,
// against 28..70 for a 3x supersampled reference).
//
// Coverage alone does not fix that — it makes the wire continuous and leaves it
// jittering. The fix is to PREFILTER: where the refine pass measured a large
// radial span, evaluate `shadeDisk` at K radii across the span and average, which
// is the disk's analogue of `starPrefilterRatio`. Radiance is conserved; do not
// fade the ring out, ever (gbuffer.md documents `starLod` as exactly that
// mistake).

/**
 * Taps across the measured span. 6, not 8: the sub-pixel span is at most the
 * whole annulus and 6 samples of a smooth radial profile already put the residual
 * well under the 8-bit output quantisation, while the thermal budget scales
 * linearly with this number. Drop to 4 before dropping the whole loop.
 */
const AA_TAPS: i32 = 6;
/**
 * Span (normalized annulus units) above which a pixel is treated as compressed.
 *
 * Below it the single centre sample is already representative and the taps would
 * be six evaluations of nearly the same radius. It is also the static gate on the
 * thermal cost: on the shipped defaults ~1.4% of pixels clear it.
 */
const AA_SPAN_MIN: f32 = 0.15;

/**
 * `shadeDisk` for the front layer, radially prefiltered where the pixel is
 * compressed.
 *
 * Mean of `color * alpha` and mean of `alpha` are accumulated SEPARATELY and
 * recombined, because emission-absorption is linear in exactly those two (see
 * `compositeDisk`): averaging `color` instead would weight the transparent taps
 * as heavily as the opaque ones and wash the ring out.
 *
 * Taps that fall outside [ISCO, diskOuter] are dropped from BOTH the sum and the
 * divisor rather than clamped: the fractional area of the annulus inside the pixel
 * is already carried by `coverage`, so clamping would pile weight onto the two
 * edge radii and bias the mean toward them.
 *
 * `footprint` comes from the caller's uniform prologue — no derivative is taken
 * in here, and none can be: this runs in non-uniform control flow. `shadeDisk`
 * samples the noise volume through `textureSampleLevel` (explicit LOD), which is
 * legal here for the same reason the existing `isHit` branches are.
 */
fn shadeFront(g: GBufferSample, footprint: f32, angularFootprint: f32) -> DiskSample {
  let annulus = max(shade.diskOuter - ISCO, 0.001);
  let spanWorld = g.span * annulus;
  if (shade.aa < 0.5 || g.span <= AA_SPAN_MIN) {
    return shadeDisk(g, disk, shade.time, footprint, noiseVolume, noiseSampler);
  }

  // Per-tap footprint, EMPHATICALLY NOT the pixel's. `disk.wgsl` inverts
  // `footprint = max(detail * dRadius, stretch * dAngle)` for its anisotropic
  // pixel ellipse, so the footprint is rebuilt here from the same two terms with
  // the radial one replaced: each tap stands for a slice `spanWorld / K` wide, not
  // for the whole span, while the angular term is still the pixel's own measured
  // one (`frontAxes.x`, from uniform control flow).
  //
  // Passing the pixel's collapsed `footprint` here instead — which is what the
  // radial term of the fwidth measurement dominates inside the band — measures
  // MEASURABLY worse: it prefilters every tap over the entire annulus, and because
  // the disk's emissivity is a 5th power of the noise field, flattening the field
  // destroys the crest energy the taps are supposed to be averaging. Measured on
  // the shipped defaults: the ring band's mean luma came out at 0.0324 (the
  // un-antialiased value) with the collapsed footprint, versus a 0.0425 reference.
  let tapFootprint = min(max(angularFootprint, max(disk.detail, 0.05) * (spanWorld / f32(AA_TAPS))), 4.0);
  let step = spanWorld / f32(AA_TAPS);
  let start = g.diskPolar.x - spanWorld * 0.5;

  var sumEmission = vec3f(0.0);
  var sumAlpha = 0.0;
  var sumDensity = 0.0;
  var taps = 0.0;
  for (var i = 0; i < AA_TAPS; i++) {
    let radius = start + (f32(i) + 0.5) * step;
    if (radius < ISCO || radius > shade.diskOuter) {
      continue;
    }
    let tap = shadeDisk(sampleAtRadius(g, radius, shade.diskOuter), disk, shade.time, tapFootprint, noiseVolume, noiseSampler);
    sumEmission += tap.color * tap.alpha;
    sumAlpha += tap.alpha;
    sumDensity += tap.density;
    taps += 1.0;
  }
  // Every tap outside the annulus: only reachable if the centre radius itself is
  // at an edge with a full-annulus span, and the honest answer then is the sample
  // we actually have.
  if (taps < 0.5) {
    return shadeDisk(g, disk, shade.time, footprint, noiseVolume, noiseSampler);
  }

  var sample: DiskSample;
  let meanAlpha = sumAlpha / taps;
  sample.alpha = meanAlpha;
  // Reconstruct the colour that reproduces the mean EMISSION through
  // `compositeDisk`'s `color * alpha`.
  sample.color = select(vec3f(0.0), (sumEmission / taps) / max(meanAlpha, 1e-6), meanAlpha > 1e-6);
  sample.density = sumDensity / taps;
  return sample;
}

/** A layer that contributes nothing, so it can be composited unconditionally. */
fn emptyDiskSample() -> DiskSample {
  var sample: DiskSample;
  sample.color = vec3f(0.0);
  sample.alpha = 0.0;
  sample.density = 0.0;
  return sample;
}

/**
 * Emission-absorption "over": the layer adds its own emergent intensity
 * (`color * alpha`, i.e. S * (1 - exp(-tau)) — see disk.wgsl) and transmits
 * `1 - alpha` of whatever is behind it.
 *
 * Compositing strictly back to front with this is what keeps the two disk
 * layers energy-correct: the hidden image is attenuated by exactly the front
 * band's opacity, so neither layer can contribute twice, and a layer with
 * alpha = 0 is an exact no-op.
 */
fn compositeDisk(under: vec3f, sample: DiskSample) -> vec3f {
  return sample.color * sample.alpha * DISK_GAIN + under * (1.0 - sample.alpha);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // The camera is frozen by the bake and there is no pointer parallax: one
  // G-buffer texel per pixel, read straight through.
  let dimensions = vec2f(textureDimensions(gHit1, 0));
  let texel = vec2i(clamp(uv * dimensions, vec2f(0.0), dimensions - vec2f(1.0)));

  // Photon-ring AA data for THIS pixel: (coverage, span) of the front crossing,
  // written by the one-shot refine pass. Outside its ~2% band it is exactly
  // (1, 0) — an exact 1 in rg8unorm — so those pixels multiply their alpha by a
  // literal one and stay bit-for-bit what they were.
  let aa = textureLoad(gAa, texel, 0).xy;
  // The synthesized crossing, and the ONLY place `Shade.aa` gates something
  // before the decode. It has to be gated here rather than downstream because a
  // substituted sample changes `isHit`, and `isHit` feeds the derivative prologue
  // below: at `aa = 0` the frame pass must see the same G-buffer it saw before
  // this pass existed, footprints included, or the A/B would not be exact.
  //
  // The load itself is unconditional (uniform control flow, one texel) and only
  // the value is selected — a branch here would be a non-uniform texture fetch in
  // the middle of the derivative prologue.
  let aaGeom = select(vec4f(0.0), textureLoad(gAaGeom, texel, 0), shade.aa > 0.5);

  let baked = decodeGBuffer(
    textureLoad(gHit1, texel, 0).xy,
    textureLoad(gHit2, texel, 0).xy,
    textureLoad(gSky, texel, 0),
    textureLoad(gView, texel, 0),
    shade.diskOuter,
    aa,
    aaGeom,
  );

  // Both footprints, in uniform control flow. The second layer sits at a
  // different radius and azimuth, so it needs its own measurement.
  //
  // Measured on the BAKED samples, before the scene rotation. A rigid rotation
  // preserves the magnitude of a derivative, but these estimators take a
  // per-component max (an L-inf norm, not a rotation-invariant one), so
  // measuring after the rotation would make the LOD breathe by up to ~sqrt(2)
  // as the mouse moves. The physical (angular / radial) footprint is invariant,
  // so the pre-rotation measurement is the correct one.
  let frontAxes = diskFootprintAxes(baked.front);
  let backAxes = diskFootprintAxes(baked.back);
  let frontFootprint = diskFootprint(frontAxes);
  let backFootprint = diskFootprint(backAxes);

  // Angular footprint of the LENSED direction map, in cube-face units per pixel
  // (the units `stars.wgsl` measures its point radius in). Also derivatives, so
  // also uniform control flow.
  //
  // Gravitational lensing compresses the whole sky into ever thinner rings as
  // the impact parameter approaches the photon sphere, so `rayDirection` sweeps
  // faster and faster across the screen near the shadow. Past ~1 star cell per
  // pixel, point sampling the star field returns an essentially uncorrelated
  // cell per pixel and the lensed sky collapses into uniform speckle that reads
  // as "unlensed stars" in a band hugging the shadow — the opposite of what
  // should be there. Same class of bug as the disk moire; the fix is to hand the
  // footprint to the sky shader and let it PREFILTER (see `starPrefilterRadius`
  // in stars.wgsl), not to fade the sky out.
  //
  // This used to multiply the stars by `starLod = 1 - smoothstep(STAR_CELL,
  // 4*STAR_CELL, skyFootprint)`, i.e. fade to black wherever a pixel spanned
  // more than one star cell. That is wrong in the limit: radiance is conserved
  // along rays, so a magnified patch of sky gets fainter and wider, never black,
  // and the fade deleted an 88 px ring of sky around the shadow at 720p —
  // exactly the annulus where the lensed images pile up, so the Einstein ring
  // was the one thing guaranteed not to render. Prefiltering with flux
  // conservation kills the speckle just as well and keeps the light.
  // Also measured on the baked direction, for the same reason as above.
  //
  // BOTH screen axes are kept, separately: the lensing map is anisotropic (it
  // compresses the sky radially while barely touching it tangentially), so a
  // single scalar footprint — the max over axes and components — is a 3-10x too
  // wide filter along the well-sampled axis and smears every star into a
  // tangential dash. `stars.wgsl` inverts the 2x2 Jacobian these two vectors
  // span and filters in SCREEN space, where a pixel is isotropic by definition.
  // The scalar below is kept only as the debug-view scale.
  let bakedRayDirection = baked.front.rayDirection;
  let skyDdx = dpdx(bakedRayDirection);
  let skyDdy = dpdy(bakedRayDirection);
  let skyFootprint = max(
    max(fwidth(bakedRayDirection.x), fwidth(bakedRayDirection.y)),
    fwidth(bakedRayDirection.z),
  );

  // Everything below this line looks at the ROTATED scene: the mouse turns the
  // world around the hole's spin axis, and the baked G-buffer is still exact
  // because the geometry is axisymmetric (see `Shade.sceneYaw`). Disk and sky
  // are rotated by the same transform, so they never slide against each other,
  // and the debug views show what was actually sampled.
  let layers = rotateLayers(baked, -shade.sceneYaw);
  let g = layers.front;
  // The sky derivatives belong to the same vector as `g.rayDirection`, so they go
  // through the same rotation. `rotateY` is linear, so rotating a difference of
  // directions is exactly the difference of the rotated directions.
  let skyDdxRotated = rotateY(skyDdx, -shade.sceneYaw);
  let skyDdyRotated = rotateY(skyDdy, -shade.sceneYaw);

  var background = vec3f(0.0);
  if (!g.isBlackHole && g.escaped) {
    background = shadeStars(g.rayDirection, stars, shade.time, skyDdxRotated, skyDdyRotated);
  }

  // The same shadeDisk, called twice with two different crossings. disk.wgsl
  // shades one layer at a time and never has to know which one it is looking at.
  var backSample = emptyDiskSample();
  var frontSample = emptyDiskSample();
  if (layers.back.isHit && shade.diskLayers > 1.5) {
    backSample = shadeDisk(layers.back, disk, shade.time, backFootprint, noiseVolume, noiseSampler);
  }
  if (layers.front.isHit) {
    frontSample = shadeFront(layers.front, frontFootprint, frontAxes.x);
    // Fractional area, applied to alpha ONLY: the covered part of the pixel keeps
    // its full radiance, it simply covers less of the pixel, so the background
    // (stars, or the hidden second image) shows through the rest. Scaling the
    // colour instead would be the `starLod` fade-to-black mistake in a new place.
    // `density` follows because it IS the opacity debug view 5 reads.
    let coverage = select(1.0, layers.front.coverage, shade.aa > 0.5);
    frontSample.alpha *= coverage;
    frontSample.density *= coverage;
  }

  // Back to front. Both composites are unconditional: an empty layer has
  // alpha = 0 and leaves `color` bit-for-bit untouched, so a pixel with a single
  // crossing produces exactly what the single-layer version produced.
  var color = background;
  color = compositeDisk(color, backSample);
  color = compositeDisk(color, frontSample);

  // Apply the layout-aware fade to the complete linear-HDR scene. Doing this
  // after the disk composites means the black hole and stars share one mask;
  // doing it before bloom means their glow fades to black with the source.
  let sideMask = mix(
    1.0,
    contentFade(uv.x, shade.resolution.x),
    clamp(shade.sideFade, 0.0, 1.0),
  );
  let centerMask = mix(
    1.0,
    centeredCopyFade(uv.y),
    clamp(shade.centerFade, 0.0, 1.0),
  );
  let heroFade = sideMask * centerMask;

  // Debug visualisations of the baked G-buffer (lil-gui "debug view").
  //
  // THEY RETURN BEFORE `tonemap`, ON PURPOSE: these channels carry data, not
  // radiance, and ACES + gamma + desaturation would make them unreadable. This
  // early-return placement is the whole reason the debug bypass survived the
  // removal of the composite pass — do not move the tone map above this block.
  //
  // Views 1..5 describe the FRONT crossing; view 7 is the second one.
  let mode = i32(shade.debugView + 0.5);
  if (mode == 10) {
    return vec4f(vec3f(heroFade), 1.0);
  }
  if (mode == 1) {
    return vec4f(g.normal * 0.5 + vec3f(0.5), 1.0);
  }
  if (mode == 2) {
    return vec4f(select(vec3f(0.0), vec3f(g.diskUv, 0.35), g.isHit), 1.0);
  }
  if (mode == 3) {
    return vec4f(f32(g.isHit), f32(g.isBlackHole), f32(g.escaped), 1.0);
  }
  if (mode == 4) {
    return vec4f(g.rayDirection * 0.5 + vec3f(0.5), 1.0);
  }
  if (mode == 5) {
    return vec4f(vec3f(frontSample.density), 1.0);
  }
  // Sky prefilter diagnostic. R = star cells crossed per pixel / 16 (so 255 means
  // 16+ cells per pixel, i.e. hopeless undersampling for a point sample),
  // G = `starPrefilterRatio` — the LINEAR attenuation the prefilter applies
  // (1 = the star already covers a pixel and keeps full brightness, -> 0 = the
  // star is smeared over the footprint and dimmed by the square of this),
  // B = 1 on pixels that sample the star field at all. Unlike the `starLod` this
  // replaced, G going to 0 no longer means "no sky here": the flux is still
  // there, spread out.
  if (mode == 6) {
    return vec4f(
      skyFootprint / (STAR_CELL * 16.0),
      starPrefilterRatio(g.rayDirection, skyDdxRotated, skyDdyRotated),
      select(0.0, 1.0, !g.isBlackHole && g.escaped),
      1.0,
    );
  }
  // Second disk crossing. B = 1 exactly where a hidden second image exists, so
  // its extent is readable at a glance; R/G carry that crossing's normalized
  // disk coordinates (radius, azimuth) to confirm the geometry is sane.
  if (mode == 7) {
    return vec4f(select(vec3f(0.0), vec3f(layers.back.diskUv, 1.0), layers.back.isHit), 1.0);
  }
  // Photon-ring AA diagnostic (the refine pass's whole output plus what the frame
  // pass did with it). R = coverage of the front crossing, G = the radial span the
  // pixel covers in normalized annulus units, B = 1 exactly where the K-tap
  // prefilter ran. So:
  //   dark red rim, B = 0  -> partial coverage, no compression: coverage only.
  //   yellow + blue        -> the compressed band; this is the ring being fixed.
  //   R > 0 on a pixel that renders black -> a dropout: coverage was measured and
  //     nothing was shaded with it. Inside the silhouette that used to be the
  //     documented "known gap"; it is now covered by the synthesized crossing, so
  //     cross-check any such pixel against view 9 before blaming the tap loop.
  if (mode == 8) {
    return vec4f(
      aa.x,
      aa.y,
      select(0.0, 1.0, shade.aa > 0.5 && g.isHit && g.span > AA_SPAN_MIN),
      1.0,
    );
  }

  color *= heroFade;
  // Synthesized-crossing diagnostic — the sub-pixel arcs that live INSIDE the
  // shadow silhouette, where no centre ray of the neighbourhood ever hit the disk
  // and coverage alone had nothing to scale. R = that crossing's normalized disk
  // radius, G = its azimuth (0..1), B = 1 exactly where the frame pass shaded a
  // synthesized sample. Black everywhere else, and black everywhere at `--aa 0`.
  //
  // Read it together with view 8: R > 0 in view 8 with a black final image and no
  // B here means a dropout the refine pass measured but could not rebuild.
  if (mode == 9) {
    return vec4f(
      select(0.0, g.diskUv.x, g.synthesized),
      select(0.0, g.diskUv.y, g.synthesized),
      select(0.0, 1.0, g.synthesized),
      1.0,
    );
  }

  // Linear HDR output. composite.wgsl adds bloom and performs the display map.
  return vec4f(color, 1.0);
}

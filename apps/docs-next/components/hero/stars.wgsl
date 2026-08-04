// STAR FIELD SHADER — shaded from the already lensed ray direction.
//
// Three jittered cube-face cell grids ("species"), each with its own angular star
// size, and a POWER-LAW brightness distribution inside every one of them, so the
// field reads as a real sky: thousands of stars below the visual threshold, a few
// hundred plain ones, a handful of bright anchors. Rewritten from the uniform
// field that shipped before, where a single brightness and a single sub-pixel
// size turned every star into the same grain of salt.
//
// WHAT IS LOAD BEARING HERE (do not remove it while retuning the look):
//
//   * the flux-conserving elliptical PREFILTER (`skyFilter`, `resolveSpecies`,
//     the mean-radiance limit in `starSpecies`) — it is what makes the lensed sky
//     around the shadow render at all, see the long comment on `SkyFilter`;
//   * the GNOMONIC CORRECTION (`Sky.fillScale` / `Sky.radiusScale`) — cube-face
//     cells are not equal solid angle, so a constant per-cell probability puts 5x
//     more stars per steradian at a cube corner than at a face centre.
//
// Cube faces (rather than a lat/long grid) keep cells near-square everywhere, and
// one jittered star per cell is a cheap blue-noise-ish point set.
//
// BUDGET: three `pcg3d` per pixel, one per species — the count this file had
// BEFORE the prefilter landed, and a quarter of the 2x2-tap version it replaces.
// Everything the prefilter adds is per-pixel, not per-star (one cube-face
// projection pair, one 2x2 inverse, two square roots), and the power law's inverse
// CDF is a single `inverseSqrt` by construction (see `COUNT_SLOPE`).

import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

/**
 * Linear radiance of the brightest possible star at `brightness = 1`, i.e. the
 * scale of the whole field. 1.6 puts the top of the distribution just into ACES
 * saturation (display 244/255 through `tonemap`), so the brightest anchors read
 * as white points without clipping into blobs.
 */
const STAR_INTENSITY: f32 = 1.9;

// --- The three species ------------------------------------------------------
//
// `CELLS` = cells per cube face (population), `FILL` = probability a cell holds a
// star at `density = 1`, `RADIUS` = the star's ANGULAR radius in radians (a face
// unit is one radian at a face centre; `SkyState.radiusScale` converts), `PEAK` =
// the brightest star of the species relative to `STAR_INTENSITY`.
//
// `FILL` IS HIGH AND `CELLS` IS LOW ON PURPOSE — that is the ONE-TAP budget (see
// `starSpecies`). A given star count can be reached with many sparse cells or few
// crowded ones, and with a single tap per species only the crowded layout is safe:
// a star is at least a pixel wide, so it has to fit inside its own cell. At the
// numbers below a star's radius is 0.05 / 0.12 / 0.20 of a cell at the frame edge
// (0.09 / 0.22 / 0.36 mid-frame), which the 0.8 jitter cannot push past an edge by
// more than a fraction of the falloff's outer skirt.
//
// Counts in the shipped 1280x720 frame (fov 2.67 sees 6.2% of the sky): ~280
// anchors, ~1890 field stars, ~4980 dust. Through the power law and the tone map
// that lands about 25 stars at display 210+, 175 at 160+, 630 at 90+ and ~4700
// visible at all; the remaining ~2450 are sub-threshold texture. The radii are
// chosen so an anchor is just over a pixel at 720p (it keeps full brightness)
// while dust is 0.4 px and is dimmed to 16% by the prefilter's coverage `gain` —
// which is what makes the three species read as three DISTANCES rather than as
// three sizes of dot.
//
// Resolution dependence, on purpose: `gain` grows with pixel density, so a
// sub-pixel star's peak value rises as pixels shrink (a point source concentrated
// into a smaller pixel really is brighter per pixel; radiance is what is
// conserved, not the pixel value). At dpr 2 the dust species crosses one pixel
// and the whole field reads brighter and denser. The field that shipped before
// behaved the same way — it is inherent to flux-conserving point sampling.
const ANCHOR_CELLS: f32 = 36.0;
const ANCHOR_FILL: f32 = 0.75;
const ANCHOR_RADIUS: f32 = 0.00110;
const ANCHOR_PEAK: f32 = 1.0;

const FIELD_CELLS: f32 = 93.0;
const FIELD_FILL: f32 = 0.75;
const FIELD_RADIUS: f32 = 0.00070;
const FIELD_PEAK: f32 = 0.45;

const DUST_CELLS: f32 = 151.0;
const DUST_FILL: f32 = 0.75;
const DUST_RADIUS: f32 = 0.00040;
const DUST_PEAK: f32 = 0.22;

/**
 * Slope of the star counts: `P(flux > f) ~ f^-COUNT_SLOPE` inside each species,
 * truncated to `[peak / contrast, peak]`. It is what makes the field read as a sky
 * rather than as a texture — only ~2% of the population lands within a factor of
 * two of its species' peak at the shipped contrast, so bright stars are rare and
 * every one of them reads as an individual.
 *
 * 2 rather than the Euclidean 1.5 (`N(>f) ~ f^-3/2`, a uniform density of equal
 * stars in flat space) for two reasons: it biases a little further towards faint
 * stars, and it makes both closed forms this file needs collapse to single cheap
 * instructions — the inverse CDF becomes `inverseSqrt` and the mean becomes
 * `2 / (contrast + 1)`. At one hash per species the sampler is a visible fraction
 * of the pass, so that matters.
 */
const COUNT_SLOPE: f32 = 2.0;

/**
 * Integral of the squared-smoothstep falloff over a disc of radius R, divided by
 * R^2: `2*pi*integral(u*(1-3u^2+2u^3)^2, u=0..1)` = 0.5385. It converts a star's
 * peak brightness into its total flux, which is what `starSpecies` needs to know
 * to fall back on a species' mean radiance.
 */
const STAR_FLUX_AREA: f32 = 0.5385;

/** Hard cap on the prefilter radius, in pixels. Only reached where the lensing
 * map is locally degenerate (a caustic), where it keeps a divide-by-zero from
 * painting a giant blob. */
const MAX_PREFILTER_PIXELS: f32 = 4.0;

/**
 * The two ends of the stellar colour ramp, both normalised to Rec.709 LUMA 1.0:
 * ~3900 K (K/M, `(1.00, 0.83, 0.63)` scaled) and ~9500 K (B/A,
 * `(0.76, 0.86, 1.00)` scaled). Because a linear blend of two luma-1 vectors is
 * also luma-1, temperature moves CHROMA ONLY — it can never change how bright a
 * star is, at any `warmth`.
 *
 * NOTE — the shipped tone map runs `SATURATION = 0` (shade.wgsl), i.e. the hero
 * is fully desaturated on output, so today this is provably invisible (measured:
 * max channel spread 0 over a whole 1280x720 frame). It is kept because it costs
 * ~4 ALU per star, it is the physically right way to spend them, and it becomes
 * visible the moment that constant is lifted off zero.
 */
const STAR_WARM: vec3f = vec3f(1.1741, 0.9745, 0.7397);
const STAR_COOL: vec3f = vec3f(0.8954, 1.0131, 1.1781);

/** Per-frame star tuning, uploaded as `stars` by renderer.ts. */
export struct StarLook {
  /** Global exposure of the whole field; 1.0 is the tuned look. */
  brightness: f32,
  /** Population multiplier on every species' per-cell probability. */
  density: f32,
  /**
   * Brightest-to-faintest flux ratio inside a species (the dynamic range of the
   * power law). Higher = a starker sky: rarer bright stars, more of the
   * population pushed below the visual threshold.
   */
  contrast: f32,
  /** Amount of per-star colour temperature, 0 = every star neutral white. */
  warmth: f32,
  /** Optional slow, per-star temporal modulation; 0.0 keeps the sky still. */
  twinkle: f32,
}

/**
 * Cube-face parameterization. A cell grid on this parameterization stays
 * near-square across the sky, avoiding the stretched stars a spherical UV grid
 * produces at its poles. `xy` in [-1,1], `z` = face index.
 */
fn faceCoords(direction: vec3f) -> vec3f {
  let magnitude = abs(direction);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    return vec3f(direction.yz / magnitude.x, select(1.0, 0.0, direction.x > 0.0));
  }
  if (magnitude.y >= magnitude.z) {
    return vec3f(direction.xz / magnitude.y, select(3.0, 2.0, direction.y > 0.0));
  }
  return vec3f(direction.xy / magnitude.z, select(5.0, 4.0, direction.z > 0.0));
}

/**
 * The same projection as `faceCoords`, but onto a CALLER-CHOSEN axis
 * (0 = x, 1 = y, 2 = z) instead of the dominant one.
 *
 * `skyFilter` differentiates the projection by finite differences, and the
 * neighbouring direction it evaluates can sit on the other side of a cube-face
 * boundary; re-deriving the face there would produce a meaningless jump. Pinning
 * the axis keeps the derivative on one smooth chart. Note the projection is
 * scale invariant (it is a ratio of components), so it does not care that the
 * differentiated direction is no longer unit length.
 */
fn faceProject(direction: vec3f, axis: i32) -> vec2f {
  if (axis == 0) {
    return direction.yz / abs(direction.x);
  }
  if (axis == 1) {
    return direction.xz / abs(direction.y);
  }
  return direction.xy / abs(direction.z);
}

/**
 * PREFILTER STATE for one pixel — the whole antialiasing of the lensed sky.
 *
 * A star is a delta function on the sky and the sky is sampled once per pixel,
 * which is the root of both artifacts this replaced:
 *
 *   * far from the hole a star can be a fraction of a pixel across, so point
 *     sampling MISSES most of them and the survivors pop in and out as the scene
 *     yaws (`gSky` is rgba16float, whose 4.9e-4 quantum is itself coarser than a
 *     sub-pixel star);
 *   * near the shadow the lensing map compresses tens of star cells into one
 *     pixel, so point sampling returns an uncorrelated cell per pixel: speckle
 *     that reads as an unlensed sky glued to the shadow.
 *
 * The fix is to convolve the sky with the PIXEL instead: draw each star at a
 * radius of at least one pixel and divide its brightness by the area it gained,
 * which conserves flux exactly. `starLod` in shade.wgsl used to fade the sky to
 * black instead — the one thing that is certainly wrong, because radiance is
 * conserved along rays (Liouville): a magnified patch of sky gets fainter per
 * pixel and covers more of them, it never goes dark. That fade deleted an 88 px
 * ring of sky around the shadow at 720p, i.e. exactly the annulus where the
 * lensed images pile up.
 *
 * THE FILTER IS ELLIPTICAL, not a disc in sky space, and that is load-bearing.
 * The lensing map is strongly anisotropic (measured at 32 deg off axis with the
 * shipped camera: ~3x more sky per pixel radially than tangentially), so a disc
 * of radius max(footprint) in FACE units is a 3-10x too wide prefilter along the
 * well-sampled axis; every star came out as a tangential dash. Working in SCREEN
 * space instead — where the pixel is isotropic by construction — makes a far
 * field star a round dot again and lets the tangential stretch appear only where
 * the map really produces it.
 *
 * `inverseJacobian` maps a face-space offset to pixels and `pixelsPerFace` is the
 * isotropic (determinant-derived) face-units-to-pixels scale each species turns
 * its own angular radius into a pixel radius with. Both are properties of the
 * PIXEL, not of a species, so they are computed once per pixel and shared.
 */
struct SkyFilter {
  inverseJacobian: mat2x2f,
  /**
   * `1 / sqrt(|det J|)`: how many pixels one face unit covers, as a single
   * isotropic number. The determinant is the right average because
   * `area on the sky per pixel = |det J|`, so a star of face radius r covers
   * `(r * pixelsPerFace)^2` pixels — that one number carries both the local
   * magnification and the resolution.
   */
  pixelsPerFace: f32,
  /**
   * LONGEST axis of the sky footprint of one pixel, in FACE units. Multiplied by
   * a species' `cells` it says how many cells that pixel covers along the
   * direction the lensing compresses hardest, which is what decides whether the
   * species can still be resolved star by star or has to fall back to its mean
   * radiance (`starSpecies`).
   *
   * The MAJOR axis and not the determinant, on purpose: near the shadow the
   * footprint is a sliver (dozens of cells radially, a fraction of one
   * tangentially) whose area — and therefore whose geometric mean — still looks
   * perfectly resolvable while the radial direction is aliasing badly.
   */
  faceMajor: f32,
}

/**
 * Builds the per-pixel prefilter from the screen-space derivatives of the lensed
 * ray direction (`dpdx`/`dpdy`, taken in shade.wgsl where the control flow is
 * uniform). `axis` is the dominant component of `direction` (`faceCoords().z / 2`),
 * passed in rather than re-derived so the whole shader classifies the face once.
 */
fn skyFilter(direction: vec3f, axis: i32, ddx: vec3f, ddy: vec3f) -> SkyFilter {
  let base = faceProject(direction, axis);
  let jx = faceProject(direction + ddx, axis) - base;
  let jy = faceProject(direction + ddy, axis) - base;

  let determinant = jx.x * jy.y - jx.y * jy.x;
  // A vanishing determinant is a caustic (or a pixel where the derivatives
  // underflowed). Clamping it keeps the inverse finite; every species' `gain` is
  // clamped to 1 independently, so no configuration can produce a
  // brighter-than-a-star pixel.
  let safeDeterminant = select(determinant, 1.0e-24, abs(determinant) < 1.0e-24);
  // inverse of the column matrix [jx jy].
  let inverse = mat2x2f(vec2f(jy.y, -jx.y), vec2f(-jy.x, jx.x)) * (1.0 / safeDeterminant);

  var prefilter: SkyFilter;
  prefilter.inverseJacobian = inverse;
  prefilter.pixelsPerFace = 1.0 / sqrt(max(abs(determinant), 1.0e-24));
  prefilter.faceMajor = max(length(jx), length(jy));
  return prefilter;
}

/**
 * Everything about this pixel and this frame that every species shares: the
 * resolved `StarLook`, the two derived constants of the power law, and the
 * GNOMONIC CORRECTION.
 *
 * The correction is why an isotropic sky comes out isotropic. Cube-face cells are
 * equal area in `(u, v)`, not in solid angle: `dOmega/dA = (1 + u^2 + v^2)^-1.5`,
 * which is 1 at a face centre and 1/5.2 at a cube corner. Left alone, a constant
 * per-cell probability therefore paints 5.2x more stars per steradian at the
 * corners — a smooth density ramp across the frame, and it moves as the mouse
 * yaws the scene. Likewise a constant radius in face units is a 1.7x smaller star
 * in solid angle there. So:
 *
 *   fillScale   = (1 + u^2 + v^2)^-1.5   (stars per steradian is now constant)
 *   radiusScale = (1 + u^2 + v^2)^0.75   (angular star size is now constant)
 *
 * Note the two exactly cancel in `fill * (radius * cells)^2`, which is the
 * species' mean radiance — an isotropic field must have a uniform mean radiance,
 * and now it provably does.
 */
struct SkyState {
  brightness: f32,
  /** `contrast^COUNT_SLOPE`, the only place the power law's range enters. */
  rangePower: f32,
  /** `E[flux]` of the truncated power law, for the mean-radiance limit. */
  meanFlux: f32,
  warmth: f32,
  twinkle: f32,
  time: f32,
  /** Density times the solid-angle correction; multiplies a species' `FILL`. */
  fillScale: f32,
  /** Radians-to-face-units for this direction; multiplies a species' `RADIUS`. */
  radiusScale: f32,
}

fn resolveSky(look: StarLook, face: vec2f, time: f32) -> SkyState {
  // Truncated power law with `P(flux > f) ~ f^-COUNT_SLOPE` on `[1/range, 1]`.
  // Inverting the survival function gives the sampler `starPoint` uses:
  //   flux(u) = (1 + u * (range^slope - 1))^(-1/slope),  u uniform in [0,1)
  // and its mean is CLOSED FORM, which is what lets `starSpecies` fall back on an
  // exact band-limited value instead of a fudge factor:
  //   E[flux] = slope/(slope-1) * (range^(slope-1) - 1) / (range^slope - 1)
  //           = 2 * (range - 1) / (range^2 - 1) = 2 / (range + 1)   (slope = 2)
  // Both are written in their slope-2 form below (`range^2`, `inverseSqrt`,
  // `2/(range+1)`); the general expressions are the two lines above. Note the mean
  // stays finite and correct all the way down to `range = 1` (every star
  // identical, E[flux] = 1), so no epsilon is needed.
  let range = clamp(look.contrast, 1.0, 512.0);
  let rangePower = range * range;

  // Solid angle per face area at this direction; see the struct comment.
  let compression = 1.0 + dot(face, face);
  let root = sqrt(compression);

  var sky: SkyState;
  sky.brightness = max(0.0, look.brightness) * STAR_INTENSITY;
  sky.rangePower = rangePower;
  sky.meanFlux = COUNT_SLOPE / (range + COUNT_SLOPE - 1.0);
  sky.warmth = clamp(look.warmth, 0.0, 1.0);
  sky.twinkle = clamp(look.twinkle, 0.0, 1.0);
  sky.time = time;
  sky.fillScale = max(0.0, look.density) / (compression * root);
  sky.radiusScale = sqrt(compression * root);
  return sky;
}

/**
 * One species, resolved for this pixel: its population, its brightest star, and
 * the three prefilter numbers that follow from its angular size.
 */
struct Species {
  cells: f32,
  /** Per-cell probability, gnomonic-corrected and density-scaled. */
  fill: f32,
  /** Linear radiance of this species' brightest star, before the power law. */
  peak: f32,
  /** Star radius in FACE units — what the mean-radiance limit integrates over. */
  faceRadius: f32,
  /** Star radius in pixels, floored at one so nothing is ever sub-pixel. */
  radiusPixels: f32,
  /**
   * Fraction of a pixel the star covers, i.e. the flux-conserving dimming that
   * pays for the floor above. Clamped at 1: once a star is bigger than a pixel it
   * is properly resolved and keeps its full surface brightness.
   */
  gain: f32,
}

fn resolveSpecies(
  cells: f32,
  fill: f32,
  peak: f32,
  angularRadius: f32,
  sky: SkyState,
  prefilter: SkyFilter,
) -> Species {
  let faceRadius = angularRadius * sky.radiusScale;
  let starPixels = faceRadius * prefilter.pixelsPerFace;

  var species: Species;
  species.cells = cells;
  species.fill = clamp(fill * sky.fillScale, 0.0, 1.0);
  species.peak = peak * sky.brightness;
  species.faceRadius = faceRadius;
  species.radiusPixels = clamp(starPixels, 1.0, MAX_PREFILTER_PIXELS);
  species.gain = min(1.0, starPixels * starPixels);
  return species;
}

/**
 * How well the sky is resolved at this pixel, for the middle species: 1 = its
 * stars are at least a pixel wide and keep their full brightness, -> 0 = one
 * pixel swallows many star cells and every star is dimmed by the SQUARE of this.
 * Exported for debug view 6.
 *
 * Unlike the `starLod` it replaced, 0 does not mean "no sky here": the flux is
 * still rendered, spread over the pixels the lensing map spread it over.
 */
export fn starPrefilterRatio(direction: vec3f, ddx: vec3f, ddy: vec3f) -> f32 {
  let d = normalize(direction);
  let face = faceCoords(d);
  let compression = 1.0 + dot(face.xy, face.xy);
  let radiusScale = sqrt(compression * sqrt(compression));
  let starPixels = FIELD_RADIUS * radiusScale
    * skyFilter(d, i32(face.z) / 2, ddx, ddy).pixelsPerFace;
  return min(1.0, starPixels);
}

/**
 * One star, from the cell it lives in. Returns its contribution to this pixel.
 *
 * `cell` is the integer cell coordinate, `grid` the pixel's continuous position
 * on the same grid, and the falloff is evaluated in SCREEN space: the offset from
 * the star is pushed through the prefilter's inverse Jacobian, so a pixel-sized
 * prefilter stays a pixel-sized prefilter no matter how anisotropically the
 * lensing map stretches the sky there.
 */
fn starPoint(
  cell: vec2f,
  grid: vec2f,
  faceIndex: i32,
  seed: i32,
  species: Species,
  sky: SkyState,
  prefilter: SkyFilter,
) -> vec3f {
  let hashed = pcg3d(bitcast<vec3u>(vec3i(vec2i(cell), faceIndex * 131 + seed)));
  let presence = unitFloat(hashed.x);
  if (presence > species.fill) {
    return vec3f(0.0);
  }

  let jitter = vec2f(unitFloat(hashed.y), unitFloat(hashed.z)) - vec2f(0.5);
  let center = cell + vec2f(0.5) + jitter * 0.8;
  // Grid -> face -> pixels. `inverseJacobian` is in face units, so the grid
  // offset is divided by `cells` before it is transformed; that is the only place
  // a species' resolution enters, and it is why one prefilter serves all three.
  let offsetPixels = prefilter.inverseJacobian * ((grid - center) / species.cells);
  let falloff = 1.0 - smoothstep(0.0, species.radiusPixels, length(offsetPixels));

  // POWER-LAW BRIGHTNESS. `presence` is uniform on [0,1) and the star exists iff
  // it is below `fill`, so `presence / fill` is uniform on [0,1) again — a free,
  // stable, already-hashed uniform to invert the count distribution with, no
  // extra hash and no correlation with position (see COUNT_SLOPE for the shape).
  let uniform01 = presence / max(species.fill, 1.0e-6);
  let flux = inverseSqrt(1.0 + uniform01 * (sky.rangePower - 1.0));

  // Chroma only — both ends of the ramp are luma 1, so temperature never changes
  // a star's brightness. Correlating the hue with the vertical jitter is
  // invisible and saves a hash.
  let tint = mix(vec3f(1.0), mix(STAR_WARM, STAR_COOL, unitFloat(hashed.y ^ hashed.z)), sky.warmth);

  // Kept deliberately gentle: at twinkle = 1 this varies by only +/- 6%, and
  // every star has a stable hash-derived phase.
  let phase = unitFloat(hashed.y) * 6.2831853;
  let shimmer = 1.0 + sky.twinkle * 0.06 * sin(sky.time * (0.35 + unitFloat(hashed.z) * 0.4) + phase);
  return tint * (falloff * falloff * species.peak * flux * shimmer * species.gain);
}

/**
 * One species: at most one jittered star per cube-face cell. The squared radial
 * falloff leaves compact, antialiased pinpoints instead of broad core-and-halo
 * blobs.
 *
 * EXACTLY ONE TAP — one hash per species, three per pixel for the whole sky. That
 * is a thermal budget decision, and the population above is designed around it:
 *
 *  * A prefiltered star is at least a pixel wide, so with a single tap it has to
 *    fit inside its own cell or it gets clipped where it crosses the boundary
 *    (only the pixels whose own cell owns the star can see it). Hence the crowded
 *    cells: at the shipped `CELLS`/`FILL` a star's radius is 0.05 / 0.12 / 0.20 of
 *    a cell at the frame edge. Worst case — the 0.8 jitter pushing a dust star to
 *    0.1 cells from an edge — cuts the profile at 0.5 of its radius, where the
 *    squared-smoothstep falloff has already dropped to 0.25, and costs about 8% of
 *    that star's flux. It is a brightness nudge on the faintest species, not a
 *    shape: at 1 px radius a "half moon" is one pixel.
 *  * Closer in, where the lensing map compresses a cell to about a pixel, the clip
 *    does get real (~15-20% of the flux for the finer species). That band is also
 *    where `cellsPerPixel` crosses 1, i.e. exactly where the mean-radiance limit
 *    below takes over from the taps, so it is absorbed rather than displayed.
 *  * What is genuinely given up is summing the SEVERAL stars a single compressed
 *    pixel contains. The analytic mean below is the estimator for that regime
 *    anyway; a 2x2 block only widened the window where the sum is a lottery.
 */
fn starSpecies(
  face: vec3f,
  seed: i32,
  species: Species,
  sky: SkyState,
  prefilter: SkyFilter,
) -> vec3f {
  let faceIndex = i32(face.z);
  let grid = face.xy * species.cells;
  let total = starPoint(floor(grid), grid, faceIndex, seed, species, sky, prefilter);

  // MEAN RADIANCE LIMIT — what the tap converges to once a pixel swallows more
  // cells than it can visit.
  //
  // Near the shadow the lensing map squeezes dozens of cells into one pixel, so a
  // single tap is a fraction of the light that is really there and the sky fades
  // out towards the shadow edge for no physical reason. The exact band-limited
  // value in that regime is analytic, because it no longer depends on WHICH stars
  // land in the pixel: every star contributes `peak * flux * gain *
  // STAR_FLUX_AREA * radiusPixels^2` spread over the pixels it covers, and a
  // pixel holds `fill * (cells * faceSpan)^2` of them, so with
  // `gain = (faceRadius / faceSpan)^2` the footprint cancels out completely:
  //
  //   mean = peak * E[flux] * fill * STAR_FLUX_AREA * (faceRadius * cells)^2
  //
  // i.e. a CONSTANT — the species' own surface brightness. That is Liouville's
  // theorem falling out of the algebra: lensing moves sky brightness around, it
  // cannot dilute it. (It is also uniform across the sky thanks to the gnomonic
  // correction: `fill` carries a factor the squared `faceRadius` cancels.)
  let extent = species.faceRadius * species.cells;
  let mean = species.peak * sky.meanFlux * species.fill * STAR_FLUX_AREA * extent * extent;
  // The mean is achromatic to the same order the population is: `E[tint]` is the
  // midpoint of a ramp whose ends are both luma 1, so it is luma 1 as well.
  let meanTint = mix(vec3f(1.0), 0.5 * (STAR_WARM + STAR_COOL), sky.warmth);
  // Cross-fade over 1..3 cells per pixel: below that the tap resolves individual
  // stars (and must, or the sky loses its stars), above it it only aliases. Each
  // species crosses over at its own footprint — the coarse 36-cell grid stays
  // resolved much closer to the shadow than the 151-cell one — which is the
  // per-species behaviour a single global `starLod` threshold could not express.
  let cellsPerPixel = species.cells * prefilter.faceMajor;
  return mix(total, meanTint * mean, smoothstep(1.0, 3.0, cellsPerPixel));
}

/**
 * Entry point used by shade.wgsl for every escaped, non-horizon ray.
 *
 * `ddx` / `ddy` are the screen-space derivatives of the LENSED ray direction, one
 * pixel apart, taken in shade.wgsl (derivatives need uniform control flow) and
 * rotated by the scene yaw together with `direction`. They are what turns the
 * field from a point sample into a prefiltered, flux-conserving one — see
 * `skyFilter`. Pass zero vectors to get the raw, aliased point field.
 */
export fn shadeStars(direction: vec3f, look: StarLook, time: f32, ddx: vec3f, ddy: vec3f) -> vec3f {
  let d = normalize(direction);
  let face = faceCoords(d);
  let prefilter = skyFilter(d, i32(face.z) / 2, ddx, ddy);
  let sky = resolveSky(look, face.xy, time);

  // Sparse bright anchors, the main field, and a dense wash of unresolved dust.
  // Every species runs the same power law, so the hierarchy inside one of them is
  // as wide as the hierarchy between them; what the three add is a spread of
  // ANGULAR SIZES (and therefore of prefilter `gain`), plus three unrelated cell
  // scales, so no single spacing is ever legible as a grid.
  return starSpecies(face, 17, resolveSpecies(ANCHOR_CELLS, ANCHOR_FILL, ANCHOR_PEAK, ANCHOR_RADIUS, sky, prefilter), sky, prefilter)
    + starSpecies(face, 71, resolveSpecies(FIELD_CELLS, FIELD_FILL, FIELD_PEAK, FIELD_RADIUS, sky, prefilter), sky, prefilter)
    + starSpecies(face, 149, resolveSpecies(DUST_CELLS, DUST_FILL, DUST_PEAK, DUST_RADIUS, sky, prefilter), sky, prefilter);
}

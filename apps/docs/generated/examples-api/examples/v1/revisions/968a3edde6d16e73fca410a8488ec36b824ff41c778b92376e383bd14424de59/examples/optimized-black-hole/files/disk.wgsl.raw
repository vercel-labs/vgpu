// ACCRETION DISK SHADER — this file is meant to be iterated on.
//
// Owned by the "disk" workstream. You can rewrite everything below `shadeDisk`
// freely; just keep the exported signatures stable:
//
//   struct DiskLook { ... }                                  <- uniform payload, see gbuffer.md
//   struct DiskSample { color: vec3f, alpha: f32, density: f32 }
//   fn shadeDisk(g, look, time, footprint, noiseTex, noiseSampler) -> DiskSample
//
// WGSL modules must stay pure: never declare @group/@binding here. The entry
// shader (shade.wgsl) owns the bindings and passes `look` in by value — and,
// since the value noise moved from an inline hash to a tiled `texture_3d`
// lattice, hands the texture and its sampler in as parameters too.

import { GBufferSample, HORIZON, ISCO } from "./gbuffer.wgsl";

/**
 * Per-frame disk tuning, uploaded as `disk` uniform by renderer.ts.
 * Every field must exist in `HeroSettings.disk` on the TS side, same names.
 * `spare0..spare3` are pre-wired free knobs (default 0) so new parameters can
 * be prototyped without touching renderer.ts / hero-black-hole.tsx.
 */
export struct DiskLook {
  /** Overall emission gain. */
  brightness: f32,
  /** Keplerian rotation speed multiplier. */
  speed: f32,
  /** Angular noise scale: lower = smoke stretched over a wider arc. */
  stretch: f32,
  /** Radial noise frequency: higher = thinner, more numerous filaments. */
  detail: f32,
  /** Chaos gain; grows toward the outer rim. */
  turbulence: f32,
  /** Opacity of the smoke (how much of the baked background it hides). */
  density: f32,
  /** Relativistic beaming strength. */
  doppler: f32,
  /** Scale of the slow, low-frequency cloud layer. */
  cloudScale: f32,
  /** Cloud rotation rate relative to the disk's rigid reference rotation. */
  cloudSpeed: f32,
  /** Multiplicative contrast of the cloud layer; 0 disables it. */
  cloudStrength: f32,
  /** spare0: lensed-arc lift. Extra emission for face-on (lensed) disk pixels. Offset around +0. */
  spare0: f32,
  /** spare1: spiral pitch offset. Logarithmic winding of the filaments. Offset around +0. */
  spare1: f32,
  /** spare2: filament contrast offset. Higher = darker lanes / harder streaks. */
  spare2: f32,
  /** spare3: outer fray offset. Extra raggedness + shortening of the outer filaments. */
  spare3: f32,
}

export struct DiskSample {
  /** Linear HDR emission, already premultiplied by its own coverage. */
  color: vec3f,
  /** 0..1 coverage used to occlude the baked background behind the disk. */
  alpha: f32,
  /** Raw coverage, exposed for the "disk density" debug view. */
  density: f32,
}

/**
 * The lattice, and how wide it is.
 *
 * `noise3` needs both the texture and its edge length on every call, and the
 * edge length has to travel with it: `textureDimensions` is uniform but reading
 * it inside the octave loops would put a resource query on the hot path. It is
 * read ONCE, in `shadeDisk`, and carried down as plain numbers.
 *
 * WGSL cannot put a texture or a sampler in a struct, so this bundles only the
 * scalars; the two handles stay explicit parameters. Ugly, and deliberate — the
 * module still declares no `@group`/`@binding` of its own (see the header), so
 * `shade.wgsl` remains the single owner of the bind group.
 */
struct NoiseLattice {
  /**
   * `1 / edge`, where edge is both the texture's side in texels and the period
   * of the noise in noise units. Read once per pixel in `shadeDisk` and passed
   * down, so the octave loops never issue a `textureDimensions` query.
   */
  invSize: f32,
}

/**
 * Value noise in 3D, read from a tiled lattice texture.
 *
 * This used to hash the eight corners of the cell inline: ~20 scalar ops per
 * corner and ~215 for the cell, all of it plain ALU (that hash was fract/dot
 * based — there are no transcendentals in it; the `cos`/`sin` belong
 * to the cylindrical embedding at the call site and are untouched by any of
 * this). The disk evaluates ~26 of those per pixel per layer, ~52 per pixel
 * over the two shear lobes, so the noise alone was ~11k ALU ops per pixel and
 * comfortably the hottest thing in the frame pass. The lattice is now baked
 * into an `r8unorm` `texture_3d` once at init (`noise-volume.mjs`, same hash,
 * same statistics) and the eight hashes plus the eight-way `mix` chain collapse
 * into ONE trilinear fetch: ~24 ALU + 1 TEX.
 *
 * That is a good trade on a GPU, where the 3D trilinear runs in the texture
 * units in parallel with the ALU, and the working set is small (64^3 r8 = 256
 * KiB, L2-resident) and coherent (the octaves finer than a pixel are skipped by
 * the `visible` fade, so neighbouring pixels stay within a texel or two). It is
 * a BAD trade on a software rasterizer, where a trilinear fetch is eight
 * dependent scalar loads and the hash is perfectly vectorizable with no memory
 * traffic at all. Both numbers were measured, on the same panel, against the
 * eight-hash version kept side by side for the purpose: on a real GPU the
 * lattice is 1.24x faster (4.10ms -> 3.30ms), on lavapipe it is ~28% SLOWER.
 * Do not benchmark this path on the software rasterizer and do not let the CPU
 * number talk you out of it.
 *
 * The cubic fade is preserved exactly, and that is the whole trick: hardware
 * filtering is LINEAR, and swapping `u = f*f*(3-2f)` for a raw `f` would round
 * off every crest — the ridged filaments would go soft and the disk would read
 * as silk. So the fade is applied to the COORDINATE instead of to the values:
 * sampling at `(i + u + 0.5) / size` makes the hardware's linear weights
 * land on exactly the eight cubic weights the analytic version computed. The
 * only differences left are the r8 quantization of the lattice and the
 * sampler's fixed-point filter weights, both ~1 LSB.
 *
 * Nothing here wraps the coordinate: the sampler's `repeat` address mode does
 * it, for free, in the addressing hardware. That is worth stating because the
 * obvious defensive version (fold the cell into `[0, size)` first, since the
 * finest octaves reach |p.z| ~ 2e3) costs 12 ALU per fetch — ~600 per pixel
 * over the ~52 fetches — to buy precision the sampler cannot use: at p.z ~ 2e3
 * an f32 holds the fade to ~1.2e-4 of a texel, while the filter weights
 * themselves are quantized to ~1/256 of a texel. Measured over four decades of
 * time: rmse 4e-5, and the worst pixel in the frame moves by 2/255.
 *
 * The disk samples this through a cylindrical embedding (cos/sin of the azimuth
 * on XY, radius on Z), which is exactly periodic in the azimuth — no atan2
 * branch cut, so no radial seam across the disk. Tiling does not disturb that:
 * the embedding closes on itself geometrically, whatever the field underneath.
 */
fn noise3(tex: texture_3d<f32>, samp: sampler, lattice: NoiseLattice, p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  // textureSampleLevel, not textureSample: the octave loops call this from
  // inside `if (visible > ...)`, which is non-uniform control flow, where the
  // implicit-derivative sample is illegal. The lattice has one mip anyway.
  return textureSampleLevel(tex, samp, (i + u + vec3f(0.5)) * lattice.invSize, 0.0).r;
}

/**
 * Anisotropic cylindrical fBm — the core of the "stretched smoke" look.
 *
 * Every octave doubles (or more) the RADIAL frequency but only barely raises
 * the ANGULAR one (`lacAng` ~ 1.4 vs `lacRad` ~ 2.3). Detail therefore piles up
 * across the flow and almost none along it: features come out as very long
 * tangential filaments instead of round puffs. That anisotropy is the whole
 * trick — an isotropic fBm can never look like Interstellar's disk.
 *
 * `dAngle` / `dRadius` are the screen footprints of one pixel along the angular
 * and the radial axis (derived in `shadeDisk` from the projected pixel
 * ellipse); octaves finer than a pixel fade to the mean, otherwise the edge-on
 * band aliases into moire.
 */
fn streakFbm(
  tex: texture_3d<f32>,
  samp: sampler,
  lattice: NoiseLattice,
  angle: f32,
  radius: f32,
  angScale: f32,
  radScale: f32,
  octaves: i32,
  /** radians of azimuth covered by one pixel (see `pixelEllipse` in shadeDisk). */
  dAngle: f32,
  /** world radius covered by one pixel. */
  dRadius: f32,
  lacAng: f32,
  lacRad: f32,
  seed: f32,
) -> f32 {
  // This loop IS the hot path: up to 5 octaves, run ~26 times per pixel per
  // layer. Everything in it was measured in half precision once (1.18x SLOWER
  // on a real GPU than plain f32 — see gbuffer.md) and is deliberately f32.
  var value: f32 = 0.0;
  var total: f32 = 0.0;
  var amplitude: f32 = 0.5;
  var a = angScale;
  var r = radScale;
  var offset = seed;
  for (var i = 0; i < octaves; i++) {
    // Per-axis Nyquist fade. `dAngle * a` is how much the cos/sin pair moves
    // across one pixel, `dRadius * r` the same for the radial axis. Computed and
    let visible = clamp(1.0 - 1.7 * max(dAngle * a, dRadius * r), 0.0, 1.0);
    // Skipping the hash when the octave is invisible is a real win: the edge-on
    // band (where the radial frequency explodes) is a large share of the pixels.
    var sampleValue: f32 = 0.5;
    if (visible > 0.004) {
      sampleValue = mix(0.5, noise3(tex, samp, lattice, vec3f(cos(angle) * a, sin(angle) * a, radius * r + offset)), visible);
    }
    value += amplitude * sampleValue;
    total += amplitude;
    a *= lacAng;
    r *= lacRad;
    offset += 23.7;
    amplitude *= 0.55;
  }
  return value / max(total, 0.0001);
}

/**
 * Ridged variant of `streakFbm`: every octave is folded through
 * `1 - |2n - 1|`, so its crests become thin, sharp lines instead of soft blobs.
 * With a radial-dominant scale (high `radScale`, low `angScale`) those crests
 * are level sets of nearly constant radius — i.e. long tangential filaments,
 * which is precisely the Interstellar thread look. Plain value fBm can only
 * ever give soft clouds because its lowest octave carries half the energy.
 */
fn ridgeFbm(
  tex: texture_3d<f32>,
  samp: sampler,
  lattice: NoiseLattice,
  angle: f32,
  radius: f32,
  angScale: f32,
  radScale: f32,
  octaves: i32,
  dAngle: f32,
  dRadius: f32,
  lacAng: f32,
  lacRad: f32,
  seed: f32,
) -> f32 {
  var value: f32 = 0.0;
  var total: f32 = 0.0;
  var amplitude: f32 = 0.5;
  var a = angScale;
  var r = radScale;
  var offset = seed;
  for (var i = 0; i < octaves; i++) {
    let visible = clamp(1.0 - 1.7 * max(dAngle * a, dRadius * r), 0.0, 1.0);
    var crest: f32 = 0.42;
    if (visible > 0.004) {
      let n = noise3(tex, samp, lattice, vec3f(cos(angle) * a, sin(angle) * a, radius * r + offset));
      // 0.42 is the mean of the folded noise, so an invisible octave decays to
      // the same average the visible one would have produced.
      crest = mix(0.42, pow(1.0 - abs(n * 2.0 - 1.0), 1.35), visible);
    }
    value += amplitude * crest;
    total += amplitude;
    a *= lacAng;
    r *= lacRad;
    offset += 41.9;
    amplitude *= 0.62;
  }
  return value / max(total, 0.0001);
}

/** Everything the smoke field needs besides the sheared flow coordinate. */
struct FieldParams {
  angBase: f32,
  radBase: f32,
  flowRad: f32,
  chaos: f32,
  outward: f32,
  dAngle: f32,
  dRadius: f32,
}

/**
 * The whole smoke field for ONE value of the flow coordinate.
 *
 * Split out of `shadeDisk` because the shear-recycling scheme below has to
 * evaluate it twice, at two different advection phases. Returns
 * `vec2f(field, rimNoise)` — the rim wobble is a by-product of the warp layers
 * and must come from the same phase as the field it frays.
 */
fn smokeField(tex: texture_3d<f32>, samp: sampler, lattice: NoiseLattice, angle: f32, radius: f32, p: FieldParams) -> vec2f {
  // --- advection ----------------------------------------------------------
  // Two low-frequency layers displace the sampling point mostly RADIALLY: that
  // makes the filaments meander across the flow while staying tangential, i.e.
  // frayed rather than blobby. Amplitude follows `chaos`, so the rim shreds.
  let warpA = (streakFbm(tex, samp, lattice, angle, radius, p.angBase * 0.55, p.flowRad * 1.6, 2, p.dAngle, p.dRadius, 1.6, 2.0, 3.7)) - 0.5;
  // warpB is deliberately short-wavelength in AZIMUTH: a warp that is smooth all
  // the way around only slides the threads sideways and keeps the silky-ring
  // look. This is the layer that actually shreds the rim.
  let warpB = (streakFbm(tex, samp, lattice, angle + 2.4, radius * 1.13, p.angBase * 2.8, p.radBase * 0.45, 3, p.dAngle, p.dRadius, 1.7, 2.0, 61.3)) - 0.5;
  let radiusW = radius + (warpA * 1.9 + warpB * 1.25 * p.outward) * p.chaos;
  let angleW = angle + (warpB * 0.9 - warpA * 0.35) * p.chaos * 0.55 / max(radius * 0.22, 0.35);

  // --- the smoke field ----------------------------------------------------
  // `flow`: angular-dominant, nearly flat radially. Its level sets run ACROSS
  // the flow, so it must stay low frequency — it is the slow bright/dark
  // modulation along the band, the only structure that survives edge-on.
  let flow = streakFbm(tex, samp, lattice, angleW, radiusW, p.angBase, p.flowRad, 3, p.dAngle, p.dRadius, 2.0, 1.12, 131.7);
  // `threads`: ridged and radial-dominant -> the long tangential filaments.
  // Level sets of a radius-dominated field are curves of nearly constant
  // radius, which is what "stretched along the rotation" means geometrically.
  let threads = ridgeFbm(tex, samp, lattice, angleW, radiusW, p.angBase * 0.85, p.radBase, 5, p.dAngle, p.dRadius, 1.26, 2.05, 0.0);

  // How much of the thread layer this pixel can actually resolve. Blending with
  // `mix` instead of a fixed sum matters: an unresolved fBm decays to a flat
  // constant and would otherwise wash the contrast out of the whole band.
  let fineVis = clamp(1.0 - 1.7 * max(p.dAngle * p.angBase * 0.85, p.dRadius * p.radBase), 0.0, 1.0);
  let field = mix(flow, flow * 0.22 + threads * 1.05, fineVis);
  // Ragged rim: feeds a noisy outer cutoff radius so the disk dissolves into
  // wisps instead of ending on a clean circle.
  let rim = (warpA + warpB * 0.5) * 0.9;
  return vec2f(f32(field), rim);
}

/** Mean of `smokeField().x`. Only used as the pivot of the contrast rescale. */
const FIELD_MEAN = 0.52;
/**
 * Radius whose orbit defines the RIGID part of the rotation. Picked so the
 * residual differential rate, weighted by the local angular noise scale, is
 * balanced between the ISCO and the rim (see the shear notes in `shadeDisk`).
 */
const SHEAR_REF_RADIUS = 6.5;
/** Seconds after which each shear lobe recycles. Max stored shear is half this. */
export const SHEAR_PERIOD: f32 = 10.0;
const TWO_PI = 6.283185307;

/**
 * Shades one disk pixel from the baked G-buffer sample.
 * `g.isHit` is guaranteed true when the entry shader calls this.
 */
export fn shadeDisk(
  g: GBufferSample,
  look: DiskLook,
  time: f32,
  footprint: f32,
  /** Tiled value-noise lattice; see `noise3` and noise-volume.mjs. */
  noiseTex: texture_3d<f32>,
  /** Must be linear min/mag with `repeat` on U, V and W. */
  noiseSampler: sampler,
) -> DiskSample {
  // Read the lattice period ONCE per pixel. `textureDimensions` is uniform, so
  // hoisting it here (instead of letting `noise3` ask for it 26 times) costs
  // nothing and keeps the shader agnostic to 64^3 vs 128^3 — the volume can be
  // resized from TypeScript alone.
  var lattice: NoiseLattice;
  lattice.invSize = 1.0 / f32(textureDimensions(noiseTex).x);

  let plane = vec2f(g.position.x, g.position.z);
  let radius = g.diskPolar.x;
  let azimuth = g.diskPolar.y;
  let radiusNorm = clamp(g.diskUv.x, 0.0, 1.0);
  let viewDirection = g.viewDirection;

  // --- viewing geometry --------------------------------------------------
  // How edge-on this pixel is. `grazing` is the slab path length multiplier,
  // and it also tells us how badly the radial axis is compressed on screen.
  let slant = max(abs(viewDirection.y), 0.022);
  let grazing = min(1.0 / slant, 34.0);

  // shade.wgsl can only hand us ONE footprint: the max over the angular and the
  // radial axis. That is catastrophic for this look — near edge-on the radial
  // axis is compressed by ~`grazing` while the tangential one stays perfectly
  // resolved, so the max blurs away exactly the long streaks we want in the
  // bright band. Recover the anisotropy analytically instead.
  //
  // One pixel projects onto the disk plane as an ellipse whose long axis lies
  // along the projected view direction and is `grazing` times the short one.
  // Decompose that ellipse onto the radial and tangential axes:
  let viewPlane = normalize(vec2f(viewDirection.x, viewDirection.z) + vec2f(1e-6, 0.0));
  let radialDir = normalize(plane + vec2f(1e-6, 0.0));
  let alignR = clamp(abs(dot(radialDir, viewPlane)), 0.0, 1.0);
  let alignT = sqrt(max(1.0 - alignR * alignR, 0.0));
  let stretchSq = grazing * grazing - 1.0;
  let kR = sqrt(1.0 + stretchSq * alignR * alignR);   // radial elongation
  let kT = sqrt(1.0 + stretchSq * alignT * alignT);   // tangential elongation
  // Invert shade.wgsl's `footprint = max(detail * dR, stretch * dTheta)` for the
  // isotropic pixel size, then redistribute it over the two axes.
  let baseScaleR = max(look.detail, 0.05);
  let baseScaleA = max(look.stretch, 0.05);
  let pixelWorld = footprint / max(baseScaleR * kR, baseScaleA * kT / max(radius, ISCO));
  let dRadius = pixelWorld * kR;
  let dAngle = pixelWorld * kT / max(radius, ISCO);

  // --- flow coordinates: Keplerian rotation with RECYCLED shear ------------
  // Keplerian differential rotation winds the filaments up: the accumulated
  // phase is `t * omega(r)`, so the shear the field sees is its radial
  // derivative, `t * omega'(r)`, which grows WITHOUT BOUND. After ~90 s it
  // dominates the radial frequency of the thread layer, the threads stop being
  // tangential, collapse below the pixel footprint and the disk degrades into a
  // gray smear. That is the "it keeps stretching" bug, and no amount of tuning
  // fixes it — the fix has to be structural.
  //
  // Split the rotation in two parts:
  //
  //   phase(r, t) = t * omegaRef            <- RIGID: same for every annulus
  //               + (omega(r) - omegaRef) * shear(t)   <- DIFFERENTIAL
  //
  // The rigid part costs nothing to run forever: the field is sampled through
  // `cos/sin(angle)`, i.e. it is EXACTLY 2*pi-periodic in the angle, so the
  // rigid phase can be wrapped with zero error and a rigid rotation never
  // shears anything. Only the differential residual deforms the field, and it
  // is the one we bound, by advecting it with a sawtooth clock instead of `t`.
  //
  // A sawtooth alone would pop when it resets, so run TWO lobes half a period
  // out of phase and cross-dissolve with triangular weights that vanish exactly
  // at each lobe's own reset (classic flow-map recycling). Every lobe always
  // advects at the true local rate d(phase)/dt = omega(r) — the motion stays
  // physically right at every radius, forever — while the stored shear never
  // exceeds half a period.
  let omega = look.speed * 0.55 / pow(radius, 1.5);
  let omegaRef = look.speed * 0.55 / pow(SHEAR_REF_RADIUS, 1.5);
  let dOmega = omega - omegaRef;
  // Wrapped: exact (2*pi-periodic field) and it keeps f32 precision at t -> inf.
  let rigid = fract(time * omegaRef / TWO_PI) * TWO_PI;
  // A static logarithmic-spiral twist on top, so the streaks read as arms and
  // not as perfectly concentric vinyl grooves.
  let swirl = max(0.0, 0.85 + look.spare1);
  let flowBase = azimuth - rigid + swirl * log(radius / ISCO);

  // Two shear clocks, half a period apart. `shear` is in seconds and stays in
  // [-T/2, +T/2]; `w` is the triangular weight, zero at the lobe's own reset.
  let cycle = time / SHEAR_PERIOD;
  let u0 = fract(cycle);
  let u1 = fract(cycle + 0.5);
  let shear0 = (u0 - 0.5) * SHEAR_PERIOD;
  let shear1 = (u1 - 0.5) * SHEAR_PERIOD;
  let w0 = 1.0 - abs(2.0 * u0 - 1.0);
  let w1 = 1.0 - w0;
  let angle0 = flowBase - dOmega * shear0;
  let angle1 = flowBase - dOmega * shear1;

  // Turbulence budget: laminar and bright inside, curdled and frayed outside.
  let outward = smoothstep(0.0, 0.92, radiusNorm);
  let fray = max(0.0, 1.0 + look.spare3);
  let chaos = look.turbulence * (0.08 + 2.10 * outward * outward) * fray;

  // Angular scale: the inner disk is stretched over a much wider arc than the
  // rim (shear dominates there), the rim breaks into shorter tufts.
  let angBase = max(look.stretch, 0.05) * 0.45 * (0.80 + 1.45 * outward * fray);
  let radBase = max(look.detail, 0.05) * 2.35;
  // Radial scale of the "flow" layer. It is deliberately ~20x coarser than the
  // filament layer: a coordinate that barely changes with radius is the only
  // thing that survives the Nyquist fade in the edge-on band, and it is what
  // paints the long bright/dark streaks ALONG the band.
  let flowRad = max(look.detail, 0.05) * 0.105;

  // --- the smoke field, evaluated once per shear lobe ----------------------
  var params: FieldParams;
  params.angBase = angBase;
  params.radBase = radBase;
  params.flowRad = flowRad;
  params.chaos = chaos;
  params.outward = outward;
  params.dAngle = dAngle;
  params.dRadius = dRadius;
  // How decorrelated the two lobes are is known analytically, BEFORE either of
  // them is evaluated: they sit `dOmega * T/2` radians apart, and the field
  // decorrelates over ~1/angBase radians — near SHEAR_REF_RADIUS they are the
  // same field. Hoisted above the calls precisely so it can gate them.
  let lobeShift = abs(dOmega) * SHEAR_PERIOD * 0.5 * angBase * 0.85;
  let rho = 1.0 - smoothstep(0.12, 1.1, lobeShift);

  // Where the code's own criterion says the lobes ARE the same field, the second
  // one is pure waste: the cross-dissolve is blending a field with itself, so
  // evaluating one field at their continuously merged coordinate gives the
  // same image for half the noise fetches. Measured on the shipped look at
  // 1280x720: `rho > 0.98` on 40.2% of
  // disk pixels, and 14.37 -> 11.51 executed noise fetches per disk pixel,
  // i.e. -19.9% of the disk's noise work (3.045 -> 2.439 per frame pixel).
  // This is per-pixel DATA divergence in screen-coherent radial bands around
  // SHEAR_REF_RADIUS — exactly the same shape as the `visible > 0.004` octave
  // skip inside the fBm loops, and NOT a uniform branch, so it costs no
  // pipeline variant and keeps one code path. `smokeField` samples through
  // `textureSampleLevel` (explicit LOD), which is legal in non-uniform control
  // flow; the footprints it uses were computed above, in uniform control flow.
  var blended: vec2f;
  // Variance the cross-dissolve destroyed; 1.0 (nothing destroyed) on the
  // single-lobe path, where `blended` still carries the field's full deviation.
  var lobeVariance = 1.0;
  if (rho > 0.98) {
    // These two coordinates sample the same local field, so one evaluation is
    // enough — but the coordinate itself must follow the crossfade. Selecting
    // the dominant lobe used to switch abruptly at w0 == 0.5 (twice per shear
    // period), producing a visible pop even though the samples were highly
    // correlated. Interpolating the coordinate is continuous; each sawtooth
    // reset still happens only while that lobe's weight is exactly zero.
    let angleMerged = mix(angle1, angle0, w0);
    blended = smokeField(noiseTex, noiseSampler, lattice, angleMerged, radius, params);
  } else {
    let lobe0 = smokeField(noiseTex, noiseSampler, lattice, angle0, radius, params);
    let lobe1 = smokeField(noiseTex, noiseSampler, lattice, angle1, radius, params);
    blended = mix(lobe1, lobe0, w0);
    // A plain cross-dissolve of two decorrelated fields loses contrast exactly
    // at the 50/50 point (var of w0*A + w1*B is (w0^2 + w1^2) * var), which
    // would show up as the disk breathing every T/2 seconds. Rescale around the
    // field mean by the variance the blend actually destroyed.
    lobeVariance = sqrt(max(w0 * w0 + w1 * w1 + 2.0 * rho * w0 * w1, 0.25));
  }
  var field = FIELD_MEAN + (blended.x - FIELD_MEAN) / lobeVariance;

  // --- slow cloud layer ---------------------------------------------------
  // A second, low-frequency field moves rigidly at a different rate and
  // MULTIPLIES the filament field. Addition would merely brighten or darken
  // the whole disk; multiplication makes large cloud masses reveal and erase
  // different groups of threads as the two patterns slide through each other.
  //
  // The cloud clock is only a rigid angular rotation, so wrapping it by 2*pi
  // is exact in the cylindrical cos/sin embedding and needs no recycled shear
  // or crossfade. Two octaves are enough at this scale and add only two noise
  // fetches per shaded disk layer.
  let cloudRate = omegaRef * look.cloudSpeed;
  let cloudRigid = fract(time * cloudRate / TWO_PI) * TWO_PI;
  let cloudAngle = azimuth - cloudRigid + 0.32 * log(radius / ISCO);
  let cloudScale = max(look.cloudScale, 0.05);
  let cloudRaw = streakFbm(
    noiseTex,
    noiseSampler,
    lattice,
    cloudAngle,
    radius,
    cloudScale,
    cloudScale * 0.34,
    2,
    dAngle,
    dRadius,
    1.72,
    1.86,
    211.7,
  );
  let cloud = smoothstep(0.28, 0.72, cloudRaw);
  let cloudStrength = clamp(look.cloudStrength, 0.0, 0.95);
  let cloudMultiplier = mix(1.0 - cloudStrength, 1.0 + cloudStrength, cloud);
  field *= cloudMultiplier;

  // --- density / emissivity split ------------------------------------------
  let rimNoise = blended.y;
  let innerEdge = smoothstep(0.0, 0.055, radiusNorm);
  let outerEdge = 1.0 - smoothstep(0.42 + rimNoise * 0.30 * fray, 1.0, radiusNorm);
  let envelope = innerEdge * outerEdge * mix(1.0, 0.62, outward);

  let contrast = max(0.2, 1.0 + look.spare2);
  let lo = 0.50 - 0.16 / contrast;
  let hi = 0.50 + 0.21 / contrast;
  // A gamma on top of the remap, not just a narrower window: it is what opens
  // real black lanes between the threads instead of a uniform gray sheet.
  var smoke = clamp(pow(smoothstep(lo, hi, field), 1.0 + 0.9 * contrast) * envelope, 0.0, 1.0);

  // A softer, wider remap of the same field drives the SURFACE BRIGHTNESS.
  // This is the piece that makes the streaks readable: where the slab is
  // optically thick (the whole edge-on band) opacity is pinned at 1 and can no
  // longer show anything, so the bright/dark lanes have to live in the emission.
  let fieldN = clamp((field - (lo - 0.10)) / max(hi - lo + 0.26, 0.02), 0.0, 1.0);
  // The crest term is what turns a gray sheet into glowing threads: the top of
  // the ridge overshoots well past 1 and blows out, the flanks stay mid-gray.
  let emissivity = (mix(0.05, 1.0, pow(fieldN, 1.35)) + 2.2 * pow(fieldN, 5.0)) * envelope;

  // --- radiative transfer --------------------------------------------------
  // The G-buffer stores a hard surface, but the disk must read as a thin slab:
  // the matter a ray traverses grows as 1/|dir.y|. The exponent compresses that
  // 20:1 edge-on/face-on ratio — with the raw 1/|dir.y| the front band is
  // opaque while the lensed arc over the shadow stays a ghost, which is exactly
  // the failure mode this shader is meant to fix.
  let path = pow(grazing, 0.62);
  let thickness = mix(0.30, 0.85, radiusNorm);
  let opticalDepth = smoke * thickness * path * look.density * 0.95;
  let coverage = 1.0 - exp(-opticalDepth);

  // Thermal gradient: white-hot at ISCO, deep orange at the rim. Only the
  // luminance matters — the tone map in shade.wgsl desaturates to 0.
  let heat = pow(1.0 - radiusNorm, 1.25);
  var thermal = mix(vec3f(0.52, 0.14, 0.03), vec3f(1.0, 0.56, 0.17), smoothstep(0.03, 0.5, heat));
  thermal = mix(thermal, vec3f(1.0, 0.94, 0.83), pow(heat, 2.2));

  // Relativistic beaming, deliberately gentle (Interstellar tones it down so the
  // disk stays nearly symmetric instead of one side being ~200x brighter).
  let tangent = normalize(vec3f(-plane.y, 0.0, plane.x));
  let orbitalSpeed = min(0.64, 0.94 / sqrt(max(radius - HORIZON, 0.25)));
  let towardObserver = dot(tangent, -normalize(viewDirection));
  let beaming = pow(clamp(1.0 / (1.0 - orbitalSpeed * towardObserver), 0.72, 1.55), 1.5 * look.doppler);
  let redshift = sqrt(max(1.0 - HORIZON / radius, 0.025));

  // The underside of the disk reads slightly dimmer than the top face.
  let facing = mix(0.82, 1.0, step(0.0, g.side));

  // Thin-disk flux profile: emission per unit area collapses with radius.
  let flux = pow(clamp(ISCO / radius, 0.0, 1.0), 1.7);
  // Incandescent core: the last few gravitational radii before the ISCO carry
  // most of the luminosity and should clip to white.
  let core = 1.0 + 2.6 * pow(1.0 - radiusNorm, 5.0);

  // Source function = surface brightness of the slab. shade.wgsl multiplies our
  // color by `alpha`, so the emergent intensity is S * (1 - exp(-tau)): it
  // SATURATES instead of growing with path length. That is what stops the
  // edge-on front band from out-shining everything and lets the lensed arc over
  // the shadow read as an equal partner.
  //
  // `arcLift` then deliberately over-weights the face-on pixels — the arc is the
  // signature Interstellar shape and we want it to lead, not to survive.
  let arcLift = max(0.0, 1.0 + look.spare0);
  let faceOn = smoothstep(0.16, 0.75, abs(viewDirection.y));
  let lift = 1.0 + 1.55 * arcLift * faceOn;
  // A small, bounded edge-on boost keeps the razor-thin incandescent silhouette.
  let edgeGlow = 1.0 + 0.55 * smoothstep(6.0, 26.0, grazing);

  let source = thermal * beaming * redshift * facing * flux * lift * edgeGlow * core * emissivity;
  let emission = source * look.brightness * 1.35;

  var sample: DiskSample;
  sample.color = vec3f(emission);
  // Wispy edges: coverage never quite reaches 1 at the fringes, so the baked
  // background (stars / horizon) bleeds through the smoke.
  sample.alpha = coverage;
  sample.density = coverage;
  return sample;
}

// BAKE PASS — runs once per camera/geometry change, never per frame.
//
// Traces one geodesic per pixel through the Schwarzschild-like field and stores
// the *result* of the ray in a G-buffer, so the per-frame pass only has to shade
// it. Because this is a one-shot cost we can afford a much finer integration
// than the old per-frame raymarch (768 steps, ~4x smaller step size), and the
// accretion disk is resolved as a HARD analytic surface (the y=0 annulus between
// ISCO and diskOuter) with an exact plane-crossing solve instead of a volume.
//
// The ray is NOT terminated at the disk: it keeps going, and it records the
// first TWO crossings of the annulus. A geodesic that grazes the hole crosses
// the disk plane more than once, so the front band hides a second, lensed image
// of the disk behind/below it; recording only the first crossing threw that
// light away. After the second hit the ray still continues to the horizon or to
// infinity, so the G-buffer also keeps the background (stars / black) both
// layers are composited against.
//
// THE INTEGRATOR ITSELF LIVES IN `geodesic.wgsl`. This file is camera setup, one
// `traceRay` call and the flag folding: the antialiasing refine pass has to trace
// sub-pixel rays with exactly this integrator, and two copies of a Verlet loop
// would drift apart. The extraction was verbatim and gated on byte-identical
// debug renders.

import { TraceResult, cameraRay, escapeRadiusFor, traceRay } from "./geodesic.wgsl";

struct Bake {
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

@group(0) @binding(0) var<uniform> bake: Bake;

/**
 * sky.w bit 0 — the ray is SHADOW: it ended inside the event horizon, or it was
 * still orbiting when MAX_STEPS ran out (see the classification at the end of
 * fs_main). Both cases mean "no sky here".
 */
const FLAG_HOLE: f32 = 1.0;
/**
 * sky.w bit 1 — the ray really did reach `escapeRadius` moving outwards, so
 * `sky.xyz` is its asymptotic direction and can be used to sample the sky.
 */
const FLAG_ESCAPED: f32 = 2.0;

// G-BUFFER LAYOUT — 4 attachments, 32 bytes per sample. See gbuffer.md.
//
// The byte budget is the whole reason this is packed rather than simply
// duplicated: WebGPU only guarantees maxColorAttachmentBytesPerSample = 32, and
// the previous single-hit layout (rgba32float + 2x rgba16float) already spent
// exactly 32. Adding a second hit therefore had to come out of redundancy, of
// which there was plenty:
//
//   * the normalized disk radius was stored even though it is just
//     (|plane| - ISCO) / (diskOuter - ISCO) — dropped, recomputed on read;
//   * `side` was stored even though a photon that hits the top face is by
//     definition travelling downward — dropped, recovered as -sign(dir.y);
//   * the hit direction was stored as a full vec3 even though it is a unit
//     vector — now 2 numbers (y and the azimuth of xz), which is also *more*
//     accurate near edge-on than three f16s were.
//
// That frees exactly enough room for a second hit at the same 32 bytes, with
// the f32 precision on the hit positions preserved (f16 quantizes to ~0.6 px at
// r ~ 15 and visibly contours the disk noise).
//
// The sub-pixel COVERAGE and SPAN of the ring are NOT here: they are a separate
// one-shot pass into a separate 2-byte target, precisely because this budget is
// spent. See `refine.wgsl` and the "AA target" section of gbuffer.md.
//
// hit1: xy = FIRST  disk crossing, position in the y=0 plane (world x, z)
// hit2: xy = SECOND disk crossing, same encoding; only written if hit1 exists
//       For both: no crossing is encoded as (0, 0) — the annulus starts at
//       ISCO, so |xy| < ISCO unambiguously means "no hit" and costs no flag.
// sky:  xyz = final lensed ray direction (used to sample the star field)
//       w   = flags: FLAG_HOLE | FLAG_ESCAPED
// view: xy = direction at the first crossing  (y, azimuth of xz)
//       zw = direction at the second crossing (y, azimuth of xz)
struct GBuffer {
  @location(0) hit1: vec2f,
  @location(1) hit2: vec2f,
  @location(2) sky: vec4f,
  @location(3) view: vec4f,
}

@fragment fn fs_main(@location(0) uv: vec2f) -> GBuffer {
  let ray = cameraRay(
    uv,
    bake.resolution,
    bake.yaw,
    bake.pitch,
    bake.orbitRadius,
    bake.fov,
    bake.centerX,
    bake.centerY,
    bake.roll,
  );
  var traced = traceRay(ray.position, ray.velocity, bake.diskOuter, escapeRadiusFor(bake.orbitRadius));

  // OUT-OF-STEPS RAYS ARE SHADOW, NOT SKY.
  //
  // This used to be `if (swallowed < 0.5) { escaped = 1.0; }`, i.e. anything
  // that did not fall in was declared to have reached infinity — including the
  // rays that simply exhausted MAX_STEPS. Those are the ones with an impact
  // parameter just above b_crit = 3*sqrt(3)/2: they wind around the photon
  // sphere many times, and when the loop gives up, `velocity` is a direction
  // half way through that winding (measured: 117 deg of deflection instead of
  // the true 252 deg at b = 2.62). Writing it as an escaped direction feeds the
  // star field an essentially random point on the sky, which is exactly the
  // speckle Fix 1 would otherwise uncover once `starLod` stops fading it out.
  //
  // A photon still orbiting after 768 steps has passed the photon sphere far
  // more slowly than any escaping ray: black is a much better approximation of
  // its (infinitely thin, infinitely wound) contribution than a truncated
  // direction, so it is folded into the shadow. With the relaxed far-field step
  // in geodesic.wgsl this band is ~2.3 px at 720p, just outside the shadow edge.
  //
  // The loop can only end three ways — fell in, escaped, ran out of steps — so
  // "neither flag set" identifies the third case exactly, and after this the
  // G-buffer never contains a sample with both flags clear.
  if (traced.swallowed < 0.5 && traced.escaped < 0.5) {
    traced.swallowed = 1.0;
  }

  return GBuffer(
    traced.hit1Plane,
    traced.hit2Plane,
    vec4f(traced.finalVelocity, traced.swallowed * FLAG_HOLE + traced.escaped * FLAG_ESCAPED),
    vec4f(traced.hit1Direction, traced.hit2Direction),
  );
}

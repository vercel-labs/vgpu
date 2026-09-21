import { fbm3, periodicFbm2, periodicPerlin2, periodicTurbulence2, periodicVoronoi2, perlin3, turbulence3, valueNoise3 } from "./noise.wgsl";
import { voronoi3d } from "@vgpu/wgsl-std/noise";
import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

// Incandescence ramp for molten rock: 0 = cold black crust, 1 = white-hot.
// Piecewise blend through deep red, orange, and yellow, in linear-ish space.
export fn blackbody(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let ember = mix(vec3f(0.0, 0.0, 0.0), vec3f(0.45, 0.015, 0.0), smoothstep(0.0, 0.30, x));
  let red = mix(ember, vec3f(1.0, 0.16, 0.01), smoothstep(0.28, 0.55, x));
  let orange = mix(red, vec3f(1.0, 0.42, 0.03), smoothstep(0.52, 0.78, x));
  return mix(orange, vec3f(1.0, 0.85, 0.45), smoothstep(0.75, 1.0, x));
}

// Gently warped coordinates shared by every lava field so cracks, relief,
// and albedo stay registered. Slow drift simulates creeping flow.
fn lavaDomain(position: vec3f, t: f32) -> vec3f {
  let drift = vec3f(0.05, 0.012, 0.028) * t;
  let q = vec3f(
    fbm3(position * 1.1 + drift, 3u),
    fbm3(position * 1.1 + vec3f(5.2, 1.3, 2.8) + drift * 0.6, 3u),
    fbm3(position * 1.1 + vec3f(1.7, 9.2, 3.1), 3u),
  );
  return position + (q - 0.5) * 0.9;
}

// Distance to the nearest crust-plate boundary (0 at a crack).
fn plateEdge(position: vec3f) -> f32 {
  let sample = voronoi3d(position);
  return sample.f2 - sample.f1;
}

// Cooling skin of the melt, Substance-style: anisotropic streak noise
// warped by perlin so the streaks follow organic flow, kept soft like a
// blurred mask instead of hard lines. 0 = fresh hot melt, 1 = cooled skin
// that merges back toward rock. Two anisotropic registers (coarse + fine)
// give the granular flow direction.
export fn meltSkin(position: vec3f, t: f32) -> f32 {
  let domain = lavaDomain(position, t);
  // Directional warp driven by perlin fbm (the tutorial's warp stage).
  let warpA = fbm3(domain * 0.8 + vec3f(4.7, 9.2, 1.3), 3u);
  let warpB = fbm3(domain * 0.8 + vec3f(11.0, 3.5, 7.7), 3u);
  let warped = domain + vec3f(warpA - 0.5, (warpB - warpA) * 0.5, warpB - 0.5) * 1.1;
  // Anisotropic streaks: long along the flow axis, fine across it.
  let streaksCoarse = fbm3(warped * vec3f(7.0, 1.8, 7.0), 4u);
  let streaksFine = fbm3(warped * vec3f(16.0, 3.5, 16.0) + vec3f(3.0, 21.0, 9.0), 3u);
  let skin = streaksCoarse * 0.72 + streaksFine * 0.28;
  // Soft remap: the viscous, merged look of slowly cooling rock.
  return smoothstep(0.38, 0.72, skin);
}

// Final glow composition: x = heat 0..1 (feed the blackbody ramp),
// y = continuous-melt mask 0..1 (liquid gloss, not ember fringe).
//
// Two families, matching reference photos: streaky melt (crack cores and
// washes, textured by the cooling meltSkin field, with white-hot contact
// rims), and a fringe over solid crust (halo + ember speckle) that only
// seeps through the crevices of the micro grain instead of sitting painted
// on top. Where the cooled skin fills in, the liquid mask carves out so the
// material shades those bands as rock again.
export fn lavaGlow(position: vec3f, t: f32) -> vec2f {
  let parts = glowParts(position, t);
  // Recombine exactly as the original single-function form did: the seeped
  // fringe joins the seep-independent heat, then the pulse, then the clamp.
  let grain = turbulence3(position * 19.0, 5u);
  let seep = smoothstep(0.62, 0.25, grain);
  let pulse = 0.9 + 0.1 * sin(t * 0.7 + parts.z * 6.2831853);
  return vec2f(clamp((parts.x + parts.w * seep) * pulse, 0.0, 1.0), parts.y);
}

// The spatial composition of lavaGlow, factored for baking:
// x = seep-independent heat (melt + wide glow base, 0..~1.6),
// y = continuous-melt mask, z = pulse phase,
// w = seepable fringe magnitude (fine cracks + halo + embers, pre-seep).
// The ember seep gates w through the micro grain; keeping it OUT of the bake
// lets the live shader apply it with the same live grain that drives the
// micro normals, so the speckle stays registered with the crevices you see.
fn glowParts(position: vec3f, t: f32) -> vec4f {
  let domain = lavaDomain(position, t);
  // Fine wiggle so voronoi boundaries stop looking ruler-straight.
  let wiggle = domain + (vec3f(
    valueNoise3(domain * 6.0),
    valueNoise3(domain * 6.0 + 11.7),
    valueNoise3(domain * 6.0 + 23.3),
  ) - 0.5) * 0.22;

  let primary = plateEdge(wiggle * 0.75);
  let secondary = plateEdge(wiggle * 1.9 + vec3f(7.1, 3.7, 1.9));

  // Not every crack is active: many have cooled shut.
  let activity = 0.12 + 0.88 * smoothstep(0.35, 0.8, fbm3(domain * 0.7 + vec3f(0.0, 0.0, 0.02) * t, 3u));

  // --- continuous melt: crack cores plus washes, laminar ---
  let coreWidth = 0.028 + 0.05 * fbm3(domain * 1.3 + vec3f(42.0, 13.0, 27.0), 3u);
  let core = smoothstep(coreWidth, 0.0, primary);
  let window = smoothstep(0.6, 0.78, fbm3(domain * 0.5, 4u));
  let flank = smoothstep(0.28, 0.04, primary) * smoothstep(0.53, 0.76, fbm3(domain * 1.1 + vec3f(17.0, 2.0, 12.0), 3u));
  let wash = clamp(window + flank * 0.9, 0.0, 1.0);
  let islands = smoothstep(0.42, 0.68, fbm3(domain * 2.1 + vec3f(6.0, 21.0, 9.0), 4u));
  let meltMask = clamp(core * (0.4 + 0.6 * activity) + wash * (1.0 - islands * 0.92), 0.0, 1.0);

  // Contact rims burn white where fresh interior is exposed: at the outer
  // edges of washes and around the crust islands floating on them.
  let washRim = smoothstep(0.02, 0.2, wash) * smoothstep(0.75, 0.28, wash);
  let islandRim = islands * (1.0 - islands) * 4.0 * wash;
  let rim = clamp(washRim + islandRim * 0.6, 0.0, 1.0) * (0.4 + 0.6 * activity);

  // The melt cools as a soft streaky skin: where the skin field fills in,
  // heat drops and the surface merges back toward rock; fresh rivulets stay
  // hot between the cooled bands. Crack cores are freshly torn and barely
  // skin over.
  let skin = meltSkin(position, t);
  let coreHeat = core * (0.4 + 0.6 * activity) * (1.0 - skin * 0.25);
  let washHeat = wash * (1.0 - islands * 0.92) * (1.0 - skin * 0.95);
  let meltHeat = clamp(coreHeat + washHeat, 0.0, 1.0) * (0.72 + 0.28 * activity) + rim * 0.55;
  // The fuller the cooled skin, the more the surface is rock again: carve
  // it out of the liquid mask so shading follows.
  let skinned = smoothstep(0.55, 0.9, skin) * wash * 0.9;

  // --- fringe over solid crust ---
  // A wide thermal gradient eases the rock-to-melt transition: crust near
  // any melt sits on a broad dim-red base instead of jumping to black.
  let warmWide = clamp(smoothstep(0.32, 0.0, primary) * 0.8 + smoothstep(0.1, 0.6, wash), 0.0, 1.0);
  let warmFalloff = warmWide * warmWide;
  let fine = smoothstep(0.035, 0.0, secondary) * 0.4 * activity * activity;
  let halo = smoothstep(0.38, 0.0, primary) * 0.22 * (0.3 + 0.7 * activity);
  let creviceFine = smoothstep(0.52, 0.24, fbm3(position * 13.0, 4u));
  let creviceCoarse = smoothstep(0.48, 0.28, fbm3(position * 5.5 + vec3f(3.0, 9.0, 1.0), 3u)) * 0.6;
  let crevice = max(creviceFine, creviceCoarse);
  let embers = crevice * warmWide * (0.25 + 0.75 * activity) * 0.7;
  // Same grain register as microDetail, so the seep sits in the crevices of
  // the micro normals you actually see.
  let glowBase = warmFalloff * 0.15;
  let heatSansSeep = meltHeat + glowBase * (1.0 - meltMask);
  let fringeSeepable = (fine + halo + embers) * (1.0 - meltMask);

  let phase = fbm3(domain, 2u);
  return vec4f(heatSansSeep, clamp(meltMask - skinned + rim * 0.5, 0.0, 1.0), phase, fringeSeepable);
}

// ---------------------------------------------------------------------------
// Bake compositors: one texel of the pre-baked field volumes. Everything the
// live material needs per fragment/vertex, packed for rgba8 storage. The live
// shader then costs a handful of texture taps instead of re-walking the whole
// noise stack (lavaDomain alone is nine fbm octaves, and the old material
// evaluated it dozens of times per fragment).

// Heat is stored sqrt-encoded over 0..HEAT_RANGE so 8 bits spend their
// precision on the dim end, where banding through the blackbody ramp shows.
const HEAT_RANGE: f32 = 1.6;

// The seepable fringe never exceeds fine + halo + embers at full activity.
const FRINGE_RANGE: f32 = 1.4;

// x = sqrt(seep-independent heat / HEAT_RANGE), y = melt mask,
// z = pulse phase, w = sqrt(seepable fringe / FRINGE_RANGE).
export fn bakeGlow(position: vec3f, t: f32) -> vec4f {
  let parts = glowParts(position, t);
  return vec4f(
    sqrt(clamp(parts.x / HEAT_RANGE, 0.0, 1.0)),
    parts.y,
    parts.z,
    sqrt(clamp(parts.w / FRINGE_RANGE, 0.0, 1.0)),
  );
}

// x = smooth crust height (scabs and pits re-added live), y = cooling skin,
// z = glassy-sheen mask, w = specular-intensity mottling.
export fn bakeSurfaceA(position: vec3f, t: f32) -> vec4f {
  let surface = crustSurface(position, t);
  let domain = lavaDomain(position, t);
  let spec = 0.55 + 0.45 * fbm3(domain * 3.0 + vec3f(9.0, 1.0, 25.0), 3u);
  return vec4f(crustHeightSmooth(position, t), meltSkin(position, t), surface.z, spec);
}

// x = tone mottling, y = oxide staining, z = fine crevice mask (the live
// shader rebuilds cavity occlusion from it plus the live pits), w = iridescence.
export fn bakeSurfaceB(position: vec3f, t: f32) -> vec4f {
  let surface = crustSurface(position, t);
  let crevice = smoothstep(0.52, 0.24, fbm3(position * 13.0, 4u));
  return vec4f(surface.x, surface.y, crevice, crustPbr(position, t).y);
}

// Vertex displacement, already combined the way the material applied it
// (relief bulge minus channel sink), biased into 0..1 for rgba8 storage.
// The live decode is (x * 0.9 - 0.4) * 0.12.
export fn bakeDisplacement(position: vec3f, t: f32) -> vec4f {
  let raw = crustRelief(position, t) * 0.5 - lavaSink(position, t) * 0.4;
  return vec4f(clamp((raw + 0.4) / 0.9, 0.0, 1.0), 0.0, 0.0, 1.0);
}

// Seamless 2D micro-detail tile. R is the four-octave mineral grain, GB are
// its derivatives with respect to normalized tile UV, and A is a single
// Perlin register sampled separately with the live streak anisotropy. The
// expensive central differences happen once here instead of per fragment.
const MICRO_TILE_SIZE: f32 = 1024.0;
const MICRO_GRAIN_PERIOD: i32 = 48;
const MICRO_STREAK_PERIOD: i32 = 64;
// Fixed from a 512^2 field-stat comparison against the former live 3D
// register: value mean/std and streak contrast land within 5%, while the raw
// derivative already matches the former bump RMS within 2%.
const MICRO_GRAIN_VALUE_SCALE: f32 = 0.8827;
const MICRO_GRAIN_VALUE_BIAS: f32 = -0.0093;
const MICRO_STREAK_CONTRAST: f32 = 0.83;

fn bakedMicroGrain(tileUv: vec2f) -> f32 {
  let period = vec2i(MICRO_GRAIN_PERIOD);
  return periodicTurbulence2(tileUv * f32(MICRO_GRAIN_PERIOD), period, 4u);
}

fn bakedMicroStreak(tileUv: vec2f) -> f32 {
  let period = vec2i(MICRO_STREAK_PERIOD);
  let raw = periodicPerlin2(tileUv * f32(MICRO_STREAK_PERIOD), period);
  return clamp(raw * 0.5 + 0.5, 0.0, 1.0);
}

export fn bakeMicroDetail(tileUv: vec2f) -> vec4f {
  let epsilon = 1.0 / MICRO_TILE_SIZE;
  let dx = vec2f(epsilon, 0.0);
  let dy = vec2f(0.0, epsilon);
  let grain = bakedMicroGrain(tileUv);
  let derivative = vec2f(
    bakedMicroGrain(tileUv + dx) - bakedMicroGrain(tileUv - dx),
    bakedMicroGrain(tileUv + dy) - bakedMicroGrain(tileUv - dy),
  ) / (2.0 * epsilon);
  let calibratedGrain = clamp(grain * MICRO_GRAIN_VALUE_SCALE + MICRO_GRAIN_VALUE_BIAS, 0.0, 1.0);
  let calibratedStreak = clamp((bakedMicroStreak(tileUv) - 0.5) * MICRO_STREAK_CONTRAST + 0.5, 0.0, 1.0);
  return vec4f(calibratedGrain, derivative, calibratedStreak);
}

// Seamless sharp-crust tile over a four-unit object-space period. R stores
// the combined scab height, GB its derivatives with respect to normalized
// tile UV, and A the union of vesicle pits and coarse flake seams. The
// 34-cell coarse register preserves the former warped field's effective
// frequency (6.5 * 1.3), while 64 and 104 cells preserve the fine flakes and
// vesicles exactly over the four-unit tile.
const SHARP_TILE_SIZE: f32 = 1024.0;
const SHARP_COARSE_PERIOD: i32 = 34;
const SHARP_FINE_PERIOD: i32 = 64;
const SHARP_PIT_PERIOD: i32 = 104;
const SHARP_CLUSTER_PERIOD: i32 = 6;
const SHARP_WARP_PERIOD: i32 = 5;

fn periodicFlakes2(position: vec2f, period: i32) -> vec2f {
  let sample = periodicVoronoi2(position, vec2i(period));
  let crack = smoothstep(0.14, 0.02, sample.y - sample.x);
  return vec2f(sample.z * (1.0 - crack * 0.75), crack);
}

fn bakedSharpWarp(tileUv: vec2f) -> vec2f {
  let period = vec2i(SHARP_WARP_PERIOD);
  let position = tileUv * f32(SHARP_WARP_PERIOD);
  return vec2f(
    periodicFbm2(position + vec2f(2.3, 7.1), period, 3u),
    periodicFbm2(position.yx + vec2f(9.7, 1.9), period.yx, 3u),
  );
}

fn bakedSharpFields(tileUv: vec2f) -> vec2f {
  // A sub-cell periodic warp keeps the coarsest Voronoi from looking like a
  // regular 2D diagram without changing the exact tile boundary.
  let coarsePosition = tileUv * f32(SHARP_COARSE_PERIOD)
    + (bakedSharpWarp(tileUv) - 0.5) * 1.7;
  let coarse = periodicFlakes2(coarsePosition, SHARP_COARSE_PERIOD);
  let fine = periodicFlakes2(
    tileUv * f32(SHARP_FINE_PERIOD) + vec2f(13.0, 5.0),
    SHARP_FINE_PERIOD,
  );
  let scabs = coarse.x * 0.16 + fine.x * 0.08;

  // A 2D Voronoi disk covers more area than a random plane through the old
  // 3D vesicle field, so the radius is reduced to preserve its sparse look.
  let pitSample = periodicVoronoi2(
    tileUv * f32(SHARP_PIT_PERIOD) + vec2f(9.0, 27.0),
    vec2i(SHARP_PIT_PERIOD),
  );
  let cluster = smoothstep(
    0.52,
    0.68,
    periodicFbm2(
      tileUv * f32(SHARP_CLUSTER_PERIOD) + vec2f(9.0, 27.0),
      vec2i(SHARP_CLUSTER_PERIOD),
      3u,
    ),
  );
  let pits = smoothstep(0.065, 0.018, pitSample.x) * cluster;
  return vec2f(scabs, max(pits, coarse.y * 0.55));
}

fn bakedSharpScabs(tileUv: vec2f) -> f32 {
  let coarsePosition = tileUv * f32(SHARP_COARSE_PERIOD)
    + (bakedSharpWarp(tileUv) - 0.5) * 1.7;
  let coarse = periodicFlakes2(coarsePosition, SHARP_COARSE_PERIOD);
  let fine = periodicFlakes2(
    tileUv * f32(SHARP_FINE_PERIOD) + vec2f(13.0, 5.0),
    SHARP_FINE_PERIOD,
  );
  return coarse.x * 0.16 + fine.x * 0.08;
}

export fn bakeSharpDetail(tileUv: vec2f) -> vec4f {
  let epsilon = 1.0 / SHARP_TILE_SIZE;
  let dx = vec2f(epsilon, 0.0);
  let dy = vec2f(0.0, epsilon);
  let fields = bakedSharpFields(tileUv);
  let derivative = vec2f(
    bakedSharpScabs(tileUv + dx) - bakedSharpScabs(tileUv - dx),
    bakedSharpScabs(tileUv + dy) - bakedSharpScabs(tileUv - dy),
  ) / (2.0 * epsilon);
  return vec4f(fields.x, derivative, fields.y);
}

// Wide, smooth channel mask for vertex displacement: 1 inside molten
// channels and pools, 0 on plate interiors. Kept low-frequency so coarse
// meshes sample it without stippling.
export fn lavaSink(position: vec3f, t: f32) -> f32 {
  let domain = lavaDomain(position, t);
  let wiggle = domain + (vec3f(
    valueNoise3(domain * 6.0),
    valueNoise3(domain * 6.0 + 11.7),
    valueNoise3(domain * 6.0 + 23.3),
  ) - 0.5) * 0.22;
  let channel = smoothstep(0.3, 0.0, plateEdge(wiggle * 0.75));
  let pools = smoothstep(0.64, 0.82, fbm3(domain * 0.5, 4u));
  return clamp(channel * 0.7 + pools, 0.0, 1.0);
}

// Pahoehoe rope folds: curved parallel cords, 0..1 with rounded crests.
// The arc term bends the bands the way drapes of skin wrinkle ahead of a
// slowly advancing lobe.
fn ropeFolds(domain: vec3f) -> f32 {
  let arc = fbm3(domain * 0.7 + vec3f(8.4, 2.2, 6.6), 3u);
  let phase = dot(domain, vec3f(2.1, 0.6, 1.6)) * 7.0 + arc * 11.0;
  let band = 0.5 + 0.5 * sin(phase + fbm3(domain * 2.6, 3u) * 2.0);
  return band * band;
}

// Where the crust is ropy pahoehoe skin vs broken clinkery rubble, 0..1.
fn ropeMask(domain: vec3f) -> f32 {
  return smoothstep(0.38, 0.62, fbm3(domain * 0.32 + vec3f(19.0, 5.0, 11.0), 3u));
}

// Flaky scabs: voronoi plates with flat tops at random per-cell heights and
// crack seams between them — the scaly, cracked-paint skin of cooled crust.
// Returns x = flake height (flat per plate, dropping into the seams),
// y = crack seam mask.
fn flakes(position: vec3f, frequency: f32) -> vec2f {
  let sample = voronoi3d(position * frequency);
  let hashed = pcg3d(bitcast<vec3u>(sample.cell));
  let plateHeight = unitFloat(hashed.x);
  let crack = smoothstep(0.14, 0.02, sample.f2 - sample.f1);
  return vec2f(plateHeight * (1.0 - crack * 0.75), crack);
}

// Clustered vesicle pits (frozen gas bubbles) in the crust skin, 1 inside a
// pit. Pits only appear in patches, the way outgassed skin does.
fn vesiclePits(position: vec3f) -> f32 {
  let cluster = smoothstep(0.52, 0.68, fbm3(position * 1.4 + vec3f(9.0, 27.0, 4.0), 3u));
  let sample = voronoi3d(position * 26.0);
  return smoothstep(0.14, 0.03, sample.f1) * cluster;
}

// Smooth vertex-scale relief, 0..1: domed plates and rope folds only. The
// flaky scabs are per-cell plateaus — skin detail for normals, not for
// vertices, where their discontinuities would show as stair-steps on the
// mesh grid.
export fn crustRelief(position: vec3f, t: f32) -> f32 {
  let domain = lavaDomain(position, t);
  let dome = smoothstep(0.0, 0.45, plateEdge(domain * 0.75));
  let lobes = ropeMask(domain);
  let rough = turbulence3(domain * 4.2, 4u) * 0.14;
  let ropes = ropeFolds(domain) * lobes * 0.38;
  return clamp(dome * 0.45 + rough + ropes + 0.12, 0.0, 1.0);
}

// The smooth half of crustHeight: domes, rubble and ropes, but no flaky
// scabs and no vesicle pits. This is what the bake stores — the scabs and
// pits are far too fine for the volume (seam masks are fractions of a texel)
// and are re-added from the seamless sharp-detail tile.
export fn crustHeightSmooth(position: vec3f, t: f32) -> f32 {
  let domain = lavaDomain(position, t);
  let dome = smoothstep(0.0, 0.45, plateEdge(domain * 0.75));
  let lobes = ropeMask(domain);
  let rough = turbulence3(domain * 4.2, 6u) * 0.14;
  let ropes = ropeFolds(domain) * lobes * 0.38;
  return clamp(dome * 0.45 + rough + ropes + 0.08, 0.0, 1.0);
}

// Crust relief height, 0..1: domed plates that sink toward the cracks,
// wrinkled into ropes on pahoehoe lobes and broken into rubble elsewhere.
export fn crustHeight(position: vec3f, t: f32) -> f32 {
  let domain = lavaDomain(position, t);
  let dome = smoothstep(0.0, 0.45, plateEdge(domain * 0.75));
  let lobes = ropeMask(domain);
  let rough = turbulence3(domain * 4.2, 6u) * 0.14;
  let ropes = ropeFolds(domain) * lobes * 0.38;
  // Scaly skin: two registers of flat-topped flakes over the soft lobes.
  let flakeCoarse = flakes(position + domain * 0.3, 6.5);
  let flakeFine = flakes(position.zxy + vec3f(13.0, 5.0, 31.0), 16.0);
  let scabs = flakeCoarse.x * 0.16 + flakeFine.x * 0.08;
  let pits = vesiclePits(position) * 0.08;
  return clamp(dome * 0.45 + rough + ropes + scabs - pits + 0.08, 0.0, 1.0);
}

// PBR refinement masks:
// x = cavity occlusion (crevices and pits trap ambient light),
// y = iridescence patches of the glassy skin,
// z = specular-intensity mottling, w = glinting mineral facets.
export fn crustPbr(position: vec3f, t: f32) -> vec4f {
  let domain = lavaDomain(position, t);
  let crevice = smoothstep(0.52, 0.24, fbm3(position * 13.0, 4u));
  let cavity = clamp(1.0 - crevice * 0.5 - vesiclePits(position) * 0.35, 0.0, 1.0);
  let irid = smoothstep(0.5, 0.8, fbm3(domain * 1.6 + vec3f(31.0, 7.0, 19.0), 3u));
  let spec = 0.55 + 0.45 * fbm3(domain * 3.0 + vec3f(9.0, 1.0, 25.0), 3u);
  let facets = smoothstep(0.72, 0.92, perlin3(position * 21.0 + vec3f(11.0, 3.0, 29.0)));
  return vec4f(cavity, irid, spec, facets);
}

// Shading masks for the crust skin:
// x = tone mottling, y = oxide staining, z = glassy-sheen mask, w = vesicle pits.
export fn crustSurface(position: vec3f, t: f32) -> vec4f {
  let domain = lavaDomain(position, t);
  let tone = turbulence3(domain * 2.4 + vec3f(3.3, 7.7, 5.1), 5u);
  let oxide = smoothstep(0.55, 0.8, fbm3(domain * 1.7 + vec3f(13.0, 3.0, 8.0), 4u));
  // Fresh pahoehoe skin cools into volcanic glass; rubble stays matte.
  let glass = smoothstep(0.45, 0.72, fbm3(domain * 1.1 + vec3f(23.0, 15.0, 2.0), 3u)) * ropeMask(domain);
  // Cavities: vesicle pits plus the crack seams between the flaky scabs
  // (same flake register as crustHeight, so shading stays registered).
  let seams = flakes(position + domain * 0.3, 6.5).y;
  let cavities = max(vesiclePits(position), seams * 0.55);
  return vec4f(tone, oxide, glass, cavities);
}

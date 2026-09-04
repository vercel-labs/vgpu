import { hash3, pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";

// ---------------------------------------------------------------------------
// Bake-only periodic 2D noise. Unlike the live 3D fields below, these helpers
// deliberately wrap the integer lattice before hashing, so both the value and
// its derivatives meet continuously across a repeating texture boundary.

fn wrapPeriodicCell2(cell: vec2i, period: vec2i) -> vec2i {
  let safePeriod = max(period, vec2i(1));
  return ((cell % safePeriod) + safePeriod) % safePeriod;
}

fn periodicGradientDot2(cell: vec2i, offset: vec2f, period: vec2i) -> f32 {
  let wrapped = wrapPeriodicCell2(cell, period);
  let index = pcg2d(bitcast<vec2u>(wrapped)).x & 7u;
  let axis = select(offset.x, offset.y, (index & 2u) != 0u);
  let axisDot = select(axis, -axis, (index & 1u) != 0u);
  let sx = select(offset.x, -offset.x, (index & 1u) != 0u);
  let sy = select(offset.y, -offset.y, (index & 2u) != 0u);
  let diagonal = 0.7071067811865476 * (sx + sy);
  return select(axisDot, diagonal, index >= 4u);
}

/** Quintic-faded Perlin noise with an exact integer-cell period. */
export fn periodicPerlin2(position: vec2f, period: vec2i) -> f32 {
  let base = floor(position);
  let cell = vec2i(base);
  let local = position - base;
  let fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
  let d00 = periodicGradientDot2(cell, local, period);
  let d10 = periodicGradientDot2(cell + vec2i(1, 0), local - vec2f(1.0, 0.0), period);
  let d01 = periodicGradientDot2(cell + vec2i(0, 1), local - vec2f(0.0, 1.0), period);
  let d11 = periodicGradientDot2(cell + vec2i(1, 1), local - vec2f(1.0, 1.0), period);
  return 1.4142 * mix(mix(d00, d10, fade.x), mix(d01, d11, fade.x), fade.y);
}

/** Four-octave tileable turbulence used only while baking micro detail. */
export fn periodicTurbulence2(position: vec2f, period: vec2i, octaves: u32) -> f32 {
  let count = clamp(octaves, 1u, 16u);
  var total = 0.0;
  var amplitude = 0.5;
  var normalization = 0.0;
  var sample = position;
  var samplePeriod = period;
  for (var i = 0u; i < count; i = i + 1u) {
    total += abs(periodicPerlin2(sample, samplePeriod)) * amplitude;
    normalization += amplitude;
    amplitude *= 0.55;
    // An integer lacunarity and an axis permutation preserve exact tiling;
    // the live field's arbitrary rotation and 2.13 multiplier would not.
    sample = sample.yx * 2.0 + vec2f(11.0, 7.0);
    samplePeriod = samplePeriod.yx * 2;
  }
  return total / max(normalization, 1e-5);
}

/** Periodic 0..1 fBm used to cluster features in baked detail tiles. */
export fn periodicFbm2(position: vec2f, period: vec2i, octaves: u32) -> f32 {
  let count = clamp(octaves, 1u, 16u);
  var total = 0.0;
  var amplitude = 0.5;
  var normalization = 0.0;
  var sample = position;
  var samplePeriod = period;
  for (var i = 0u; i < count; i = i + 1u) {
    total += periodicPerlin2(sample, samplePeriod) * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    sample = sample.yx * 2.0 + vec2f(11.0, 7.0);
    samplePeriod = samplePeriod.yx * 2;
  }
  return clamp(total / max(normalization, 1e-5) * 0.5 + 0.5, 0.0, 1.0);
}

/**
 * Tileable 2D Voronoi. x/y are the nearest and second-nearest distances;
 * z is a stable random value for the nearest cell. Candidate cells keep
 * their unwrapped offsets for distance, but wrap before hashing, so features
 * and their derivatives meet at either side of the tile.
 */
export fn periodicVoronoi2(position: vec2f, period: vec2i) -> vec3f {
  let base = floor(position);
  let cell = vec2i(base);
  let local = position - base;
  var nearest = 1e10;
  var secondNearest = 1e10;
  var cellValue = 0.0;

  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      let offset = vec2i(x, y);
      let wrapped = wrapPeriodicCell2(cell + offset, period);
      let hashed = pcg2d(bitcast<vec2u>(wrapped));
      let feature = vec2f(unitFloat(hashed.x), unitFloat(hashed.y));
      let distance = length(vec2f(offset) + feature - local);
      if (distance < nearest) {
        secondNearest = nearest;
        nearest = distance;
        cellValue = unitFloat(pcg2d(hashed).x);
      } else if (distance < secondNearest) {
        secondNearest = distance;
      }
    }
  }

  return vec3f(nearest, secondNearest, cellValue);
}

// Trilinear value noise over a lattice hashed with @vgpu/wgsl-std's hash3.
export fn valueNoise3(position: vec3f) -> f32 {
  let cell = floor(position);
  let local = fract(position);
  let fade = local * local * (3.0 - 2.0 * local);
  let c000 = hash3(cell + vec3f(0.0, 0.0, 0.0)).x;
  let c100 = hash3(cell + vec3f(1.0, 0.0, 0.0)).x;
  let c010 = hash3(cell + vec3f(0.0, 1.0, 0.0)).x;
  let c110 = hash3(cell + vec3f(1.0, 1.0, 0.0)).x;
  let c001 = hash3(cell + vec3f(0.0, 0.0, 1.0)).x;
  let c101 = hash3(cell + vec3f(1.0, 0.0, 1.0)).x;
  let c011 = hash3(cell + vec3f(0.0, 1.0, 1.0)).x;
  let c111 = hash3(cell + vec3f(1.0, 1.0, 1.0)).x;
  let bottom = mix(mix(c000, c100, fade.x), mix(c010, c110, fade.x), fade.y);
  let top = mix(mix(c001, c101, fade.x), mix(c011, c111, fade.x), fade.y);
  return mix(bottom, top, fade.z);
}

fn gradientAt(cell: vec3f) -> vec3f {
  return hash3(cell) * 2.0 - 1.0;
}

// Quintic-faded gradient (Perlin-style) noise, ~0..1. Much crisper than
// value noise: features are isotropic blobs instead of blurry lattice cells.
export fn perlin3(position: vec3f) -> f32 {
  let cell = floor(position);
  let local = fract(position);
  let fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
  let d000 = dot(gradientAt(cell + vec3f(0.0, 0.0, 0.0)), local - vec3f(0.0, 0.0, 0.0));
  let d100 = dot(gradientAt(cell + vec3f(1.0, 0.0, 0.0)), local - vec3f(1.0, 0.0, 0.0));
  let d010 = dot(gradientAt(cell + vec3f(0.0, 1.0, 0.0)), local - vec3f(0.0, 1.0, 0.0));
  let d110 = dot(gradientAt(cell + vec3f(1.0, 1.0, 0.0)), local - vec3f(1.0, 1.0, 0.0));
  let d001 = dot(gradientAt(cell + vec3f(0.0, 0.0, 1.0)), local - vec3f(0.0, 0.0, 1.0));
  let d101 = dot(gradientAt(cell + vec3f(1.0, 0.0, 1.0)), local - vec3f(1.0, 0.0, 1.0));
  let d011 = dot(gradientAt(cell + vec3f(0.0, 1.0, 1.0)), local - vec3f(0.0, 1.0, 1.0));
  let d111 = dot(gradientAt(cell + vec3f(1.0, 1.0, 1.0)), local - vec3f(1.0, 1.0, 1.0));
  let bottom = mix(mix(d000, d100, fade.x), mix(d010, d110, fade.x), fade.y);
  let top = mix(mix(d001, d101, fade.x), mix(d011, d111, fade.x), fade.y);
  return clamp(mix(bottom, top, fade.z) * 0.72 + 0.5, 0.0, 1.0);
}

// Rotation applied between fbm octaves so no lattice direction survives.
const octaveRotation = mat3x3f(
  vec3f(0.0, 0.8, 0.6),
  vec3f(-0.8, 0.36, -0.48),
  vec3f(0.6, -0.48, 0.64),
);

export fn fbm3(position: vec3f, octaves: u32) -> f32 {
  var total = 0.0;
  var amplitude = 0.5;
  var sample = position;
  var normalization = 0.0;
  for (var i = 0u; i < octaves; i++) {
    total += perlin3(sample) * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    sample = octaveRotation * sample * 2.03 + vec3f(11.5, 5.2, 7.8);
  }
  return total / max(normalization, 1e-5);
}

// Turbulence: fbm over |signed noise|. The absolute value folds every zero
// crossing into a crease, so the result reads as fractal rock rather than
// smooth clouds.
export fn turbulence3(position: vec3f, octaves: u32) -> f32 {
  var total = 0.0;
  var amplitude = 0.5;
  var sample = position;
  var normalization = 0.0;
  for (var i = 0u; i < octaves; i++) {
    total += abs(perlin3(sample) * 2.0 - 1.0) * amplitude;
    normalization += amplitude;
    amplitude *= 0.55;
    sample = octaveRotation * sample * 2.13 + vec3f(11.5, 5.2, 7.8);
  }
  return total / max(normalization, 1e-5);
}

// Ridged multifractal: sharp creases where the noise crosses its midline.
// Returns 0..1 with thin bright ridges near 1.
export fn ridged3(position: vec3f, octaves: u32) -> f32 {
  var total = 0.0;
  var amplitude = 0.5;
  var sample = position;
  var normalization = 0.0;
  for (var i = 0u; i < octaves; i++) {
    let ridge = 1.0 - abs(perlin3(sample) * 2.0 - 1.0);
    total += ridge * ridge * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    sample = octaveRotation * sample * 2.03 + vec3f(11.5, 5.2, 7.8);
  }
  return total / max(normalization, 1e-5);
}

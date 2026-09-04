// Procedural lens dirt, baked once into a small texture: soft dust clouds,
// smeared wipes, a sprinkle of specks and a few sparkles. composite.wgsl reads
// it to warp and haze the image like a fingerprinted front element.

import { hash2 } from "@vgpu/wgsl-std/hash";

struct Dirt {
  size: vec2f,
}

@group(0) @binding(0) var<uniform> dirt: Dirt;

fn smooth01(t: f32) -> f32 {
  return t * t * (3.0 - 2.0 * t);
}

fn cellHash(cell: vec2f, seed: f32) -> vec2f {
  return hash2(cell + vec2f(seed * 17.13, seed * 3.71));
}

// Bilinear value noise on a `cells` grid.
fn valueNoise(uv: vec2f, cells: vec2f, seed: f32) -> f32 {
  let p = uv * cells;
  let i = floor(p);
  let f = p - i;
  let s = vec2f(smooth01(f.x), smooth01(f.y));
  let a = cellHash(i, seed).x;
  let b = cellHash(i + vec2f(1.0, 0.0), seed).x;
  let c = cellHash(i + vec2f(0.0, 1.0), seed).x;
  let d = cellHash(i + vec2f(1.0, 1.0), seed).x;
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// Small grainy specks on a jittered grid; a 3×3 neighbourhood keeps them
// from clipping at cell borders.
fn specks(pixel: vec2f, cellSize: f32, seed: f32) -> f32 {
  let cell = floor(pixel / cellSize);
  var value = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbour = cell + vec2f(f32(x), f32(y));
      let h = cellHash(neighbour, seed);
      let g = cellHash(neighbour + vec2f(7.0, 11.0), seed);
      if (h.x > 0.62) {
        continue;
      }
      let center = (neighbour + vec2f(0.15) + 0.7 * vec2f(h.y, g.x)) * cellSize;
      let radius = 0.52 + 1.15 * pow(g.y, 3.0);
      let d = length(pixel - center) / max(radius, 0.5);
      if (d >= 1.0) {
        continue;
      }
      let grainSeed = hash2(pixel + vec2f(seed)).x;
      if (d > 0.42 && grainSeed < 0.3 + 0.24 * d) {
        continue;
      }
      let strength = 0.24 + 0.7 * pow(h.y, 1.8);
      value = max(value, strength * (1.0 - smoothstep(0.48, 1.0, d)) * (0.52 + 0.48 * grainSeed));
    }
  }
  return value;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = uv * dirt.size;
  let coarse = valueNoise(uv, vec2f(13.0, 10.0), 1.0);
  let fine = valueNoise(uv, vec2f(47.0, 35.0), 2.0);
  let noise = hash2(pixel + vec2f(0.5)).x;
  let clouds = smoothstep(0.43, 0.74, 0.68 * coarse + 0.32 * fine);
  var value = 0.018 + 0.032 * coarse + 0.022 * fine + 0.012 * noise + clouds * (0.038 + 0.032 * noise);

  // Elliptical wipes with a streaky sine grain, as if smeared by a cloth.
  for (var i = 0; i < 7; i++) {
    let seed = f32(i) + 3.0;
    let a = cellHash(vec2f(seed, 1.0), 5.0);
    let b = cellHash(vec2f(seed, 2.0), 5.0);
    let c = cellHash(vec2f(seed, 3.0), 5.0);
    let d = cellHash(vec2f(seed, 4.0), 5.0);
    let angle = a.x * 3.14159265;
    let center = vec2f(0.08 + 0.84 * a.y, 0.08 + 0.84 * b.x);
    let radii = vec2f(0.08 + 0.18 * b.y, 0.035 + 0.09 * c.x);
    let frequency = 8.0 + 18.0 * c.y;
    let phase = d.x * 6.28318;
    let strength = 0.035 + 0.075 * d.y;
    let delta = uv - center;
    let cs = cos(angle);
    let sn = sin(angle);
    let along = (delta.x * cs + delta.y * sn) / radii.x;
    let acrossWipe = (-delta.x * sn + delta.y * cs) / radii.y;
    let d2 = along * along + acrossWipe * acrossWipe;
    if (d2 >= 1.0) {
      continue;
    }
    let falloff = 1.0 - smoothstep(0.18, 1.0, sqrt(d2));
    let streak = pow(0.5 + 0.5 * sin((0.72 * along + acrossWipe) * frequency + phase), 8.0);
    value += strength * falloff * (0.18 + 0.82 * streak) * (0.5 + 0.5 * noise);
  }

  let spark = hash2(pixel + vec2f(101.0, 37.0)).y;
  if (spark > 0.965) {
    value += 0.5 * pow((spark - 0.965) / 0.035, 1.8);
  }
  value = max(value, specks(pixel, 7.0, 9.0));
  value = max(value, specks(pixel, 23.0, 13.0) * 0.8);

  let v = pow(clamp(value, 0.0, 1.0), 0.94);
  return vec4f(v, v, v, 1.0);
}

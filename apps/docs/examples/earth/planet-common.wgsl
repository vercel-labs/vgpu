// Deterministic procedural helpers shared by the bake and live shaders.

import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

export const PI: f32 = 3.141592653589793;

fn latticeGradient(cell: vec3i) -> vec3f {
  let index = pcg3d(bitcast<vec3u>(cell)).x % 12u;
  switch (index) {
    case 0u: { return vec3f(1.0, 1.0, 0.0); }
    case 1u: { return vec3f(-1.0, 1.0, 0.0); }
    case 2u: { return vec3f(1.0, -1.0, 0.0); }
    case 3u: { return vec3f(-1.0, -1.0, 0.0); }
    case 4u: { return vec3f(1.0, 0.0, 1.0); }
    case 5u: { return vec3f(-1.0, 0.0, 1.0); }
    case 6u: { return vec3f(1.0, 0.0, -1.0); }
    case 7u: { return vec3f(-1.0, 0.0, -1.0); }
    case 8u: { return vec3f(0.0, 1.0, 1.0); }
    case 9u: { return vec3f(0.0, -1.0, 1.0); }
    case 10u: { return vec3f(0.0, 1.0, -1.0); }
    default: { return vec3f(0.0, -1.0, -1.0); }
  }
}

fn quinticFade(t: vec3f) -> vec3f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

export fn perlin3(position: vec3f) -> f32 {
  let base = floor(position);
  let cell = vec3i(base);
  let f = position - base;
  let w = quinticFade(f);

  let n000 = dot(latticeGradient(cell + vec3i(0, 0, 0)), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(latticeGradient(cell + vec3i(1, 0, 0)), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(latticeGradient(cell + vec3i(0, 1, 0)), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(latticeGradient(cell + vec3i(1, 1, 0)), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(latticeGradient(cell + vec3i(0, 0, 1)), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(latticeGradient(cell + vec3i(1, 0, 1)), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(latticeGradient(cell + vec3i(0, 1, 1)), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(latticeGradient(cell + vec3i(1, 1, 1)), f - vec3f(1.0, 1.0, 1.0));

  let x00 = mix(n000, n100, w.x);
  let x10 = mix(n010, n110, w.x);
  let x01 = mix(n001, n101, w.x);
  let x11 = mix(n011, n111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

fn octaveRotation() -> mat3x3f {
  return mat3x3f(
    vec3f(0.00, 0.80, 0.60),
    vec3f(-0.80, 0.36, -0.48),
    vec3f(-0.60, -0.48, 0.64),
  );
}

export fn fbm3(position: vec3f, octaves: i32) -> f32 {
  let rotation = octaveRotation();
  var point = position;
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + amplitude * perlin3(point);
    total = total + amplitude;
    amplitude = amplitude * 0.5;
    point = rotation * point * 2.0;
  }
  return sum / max(total, 1.0e-6);
}

export fn ridged3(position: vec3f, octaves: i32) -> f32 {
  let rotation = octaveRotation();
  var point = position;
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i = i + 1) {
    let ridge = 1.0 - abs(perlin3(point));
    sum = sum + amplitude * ridge * ridge;
    total = total + amplitude;
    amplitude = amplitude * 0.5;
    point = rotation * point * 2.0;
  }
  return sum / max(total, 1.0e-6);
}

export fn fbmVector(position: vec3f, octaves: i32) -> vec3f {
  return vec3f(
    fbm3(position, octaves),
    fbm3(position + vec3f(37.19, 11.73, 5.41), octaves),
    fbm3(position + vec3f(-13.07, 71.31, 29.83), octaves),
  );
}

export fn equirectDirection(uv: vec2f) -> vec3f {
  let theta = uv.y * PI;
  let phi = uv.x * 2.0 * PI;
  let ring = sin(theta);
  return vec3f(ring * cos(phi), cos(theta), ring * sin(phi));
}

export fn valueRemap(value: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
  let span = inMax - inMin;
  if (span == 0.0) {
    return outMin;
  }
  return outMin + (outMax - outMin) * (value - inMin) / span;
}

export fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

export fn belt(value: f32, center: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(0.0, width, abs(value - center));
}

const SEA_LEVEL: f32 = 0.13;

export fn elevation(direction: vec3f) -> f32 {
  let warp = fbmVector(direction * 1.05 + vec3f(4.7, -2.3, 8.1), 3) * 0.60;
  let continents = fbm3(direction * 1.25 + warp, 6);
  let ranges = fbm3(direction * 3.6 + vec3f(19.0), 4) * 0.26;
  let coastline = fbm3(direction * 13.0 + vec3f(-7.0), 3) * 0.055;
  return continents + ranges + coastline - SEA_LEVEL;
}

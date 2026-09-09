// Tileable 3D noise for the cloud textures. Every function wraps its lattice at `period`, so a
// texture filled over [0, 1) with an integer frequency repeats seamlessly.

fn pcg3d(input: vec3u) -> vec3u {
  var v = input * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn hashCell(cell: vec3i, period: i32) -> vec3f {
  let wrapped = vec3u((cell % period + period) % period);
  return vec3f((pcg3d(wrapped) >> vec3u(8u)) & vec3u(0xffffffu)) / 16777215.0;
}

/** Tileable gradient noise in roughly [-1, 1]. */
export fn perlin3(p: vec3f, period: f32) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let base = vec3i(cell);
  let n = i32(period);
  var corners: array<f32, 8>;
  for (var i = 0; i < 8; i += 1) {
    let offset = vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    let gradient = normalize(hashCell(base + offset, n) * 2.0 - 1.0);
    corners[i] = dot(gradient, f - vec3f(offset));
  }
  let x0 = mix(corners[0], corners[1], w.x);
  let x1 = mix(corners[2], corners[3], w.x);
  let x2 = mix(corners[4], corners[5], w.x);
  let x3 = mix(corners[6], corners[7], w.x);
  return mix(mix(x0, x1, w.y), mix(x2, x3, w.y), w.z) * 1.4;
}

/** Tileable cellular noise: distance to the nearest feature point, in [0, ~1]. */
export fn worley3(p: vec3f, period: f32) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let base = vec3i(cell);
  let n = i32(period);
  var minDistance = 1e9;
  for (var z = -1; z <= 1; z += 1) {
    for (var y = -1; y <= 1; y += 1) {
      for (var x = -1; x <= 1; x += 1) {
        let offset = vec3i(x, y, z);
        let feature = hashCell(base + offset, n) + vec3f(offset) - f;
        minDistance = min(minDistance, dot(feature, feature));
      }
    }
  }
  return sqrt(minDistance);
}

export fn perlinFbm(p: vec3f, frequency: f32, octaves: i32) -> f32 {
  var f = frequency;
  var amplitude = 1.0;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i += 1) {
    sum += perlin3(p * f, f) * amplitude;
    norm += amplitude;
    f *= 2.0;
    amplitude *= 0.5;
  }
  return sum / norm;
}

export fn remap(value: f32, low: f32, high: f32, newLow: f32, newHigh: f32) -> f32 {
  return newLow + (value - low) / (high - low) * (newHigh - newLow);
}

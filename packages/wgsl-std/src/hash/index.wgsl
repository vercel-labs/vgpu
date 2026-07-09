export fn hashU32(value: u32) -> u32 {
  var hashed = value;
  hashed = (hashed ^ (hashed >> 16u)) * 0x7feb352du;
  hashed = (hashed ^ (hashed >> 15u)) * 0x846ca68bu;
  hashed = hashed ^ (hashed >> 16u);
  return hashed;
}

export fn pcg2d(value: vec2u) -> vec2u {
  var hashed = value * 1664525u + 1013904223u;
  hashed.x = hashed.x + hashed.y * 1664525u;
  hashed.y = hashed.y + hashed.x * 1664525u;
  hashed = hashed ^ (hashed >> vec2u(16u));
  hashed.x = hashed.x + hashed.y * 1664525u;
  hashed.y = hashed.y + hashed.x * 1664525u;
  hashed = hashed ^ (hashed >> vec2u(16u));
  return hashed;
}

export fn pcg3d(value: vec3u) -> vec3u {
  var hashed = value * 1664525u + 1013904223u;
  hashed.x = hashed.x + hashed.y * hashed.z;
  hashed.y = hashed.y + hashed.z * hashed.x;
  hashed.z = hashed.z + hashed.x * hashed.y;
  hashed = hashed ^ (hashed >> vec3u(16u));
  hashed.x = hashed.x + hashed.y * hashed.z;
  hashed.y = hashed.y + hashed.z * hashed.x;
  hashed.z = hashed.z + hashed.x * hashed.y;
  return hashed;
}

export fn unitFloat(hash: u32) -> f32 {
  return f32(hash >> 8u) * (1.0 / 16777216.0);
}

export fn hash1(seed: f32) -> f32 {
  return unitFloat(hashU32(bitcast<u32>(seed)));
}

export fn hash2(seed: vec2f) -> vec2f {
  let hashed = pcg2d(bitcast<vec2u>(seed));
  return vec2f(unitFloat(hashed.x), unitFloat(hashed.y));
}

export fn hash3(seed: vec3f) -> vec3f {
  let hashed = pcg3d(bitcast<vec3u>(seed));
  return vec3f(unitFloat(hashed.x), unitFloat(hashed.y), unitFloat(hashed.z));
}

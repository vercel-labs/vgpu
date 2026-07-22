struct NoiseUniforms { seed: u32 };
@group(0) @binding(0) var<uniform> u: NoiseUniforms;

fn hash32(value: u32) -> u32 {
  var x = value;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  return x ^ (x >> 16u);
}
fn uniform01(value: u32) -> f32 { return (f32(hash32(value)) + 0.5) / 4294967296.0; }
fn gaussianPair(a: u32, b: u32) -> vec2f {
  let magnitude = sqrt(-2.0 * log(max(uniform01(a), 1e-7)));
  let angle = 6.283185307179586 * uniform01(b);
  return magnitude * vec2f(cos(angle), sin(angle));
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coord = vec2u(position.xy - vec2f(0.5));
  let base = u.seed ^ (coord.x * 0x9e3779b9u) ^ (coord.y * 0x85ebca6bu);
  return vec4f(gaussianPair(base, base + 1u), gaussianPair(base + 2u, base + 3u));
}

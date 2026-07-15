struct Uniforms {
  time: f32,
  resolution: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 6; i++) {
    sum += amp * noise(p);
    p *= 2.03;
    amp *= 0.52;
  }
  return sum;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = uv * 3.0 + vec2f(uniforms.time * 0.07, -uniforms.time * 0.05);
  let n = fbm(p + fbm(p + 2.0));
  let color = mix(vec3f(0.03, 0.05, 0.14), vec3f(0.15, 0.72, 1.0), smoothstep(0.25, 0.95, n));
  return vec4f(color + vec3f(n * 0.12), 1.0);
}

// Slow-moving aurora ribbons over a night sky. Cool palette: deep blue to cyan.
struct Params {
  time: f32,
  aspect: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * (r.x - r.y + 7.7));
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
    value += amplitude * noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

fn palette(t: f32) -> vec3f {
  let deep = vec3f(0.02, 0.08, 0.28);
  let mid = vec3f(0.05, 0.45, 0.70);
  let bright = vec3f(0.35, 0.95, 0.90);
  return mix(mix(deep, mid, smoothstep(0.0, 0.6, t)), bright, smoothstep(0.55, 1.0, t));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2f((uv.x - 0.5) * params.aspect, uv.y - 0.5) * 2.0;
  let t = params.time * 0.08;
  let drift = vec2f(t, t * 0.35);
  let warp = fbm(p * 1.4 + drift);
  let ribbons = fbm(p * 2.2 + vec2f(warp * 1.6, -warp * 0.8) - drift);
  let band = exp(-abs(p.y + 0.25 - 0.3 * sin(p.x * 1.4 + t * 4.0)) * 2.2);
  let intensity = max(0.0, ribbons - 0.38) * band * 2.6;
  let sky = mix(vec3f(0.01, 0.015, 0.04), vec3f(0.02, 0.03, 0.08), smoothstep(-1.0, 1.0, p.y));
  let color = sky + palette(clamp(intensity + uv.y * 0.15, 0.0, 1.0)) * intensity;
  return vec4f(color, 1.0);
}

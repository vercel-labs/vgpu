// Animated volumetric "aurora" field. The same shader serves both quality
// tiers: `steps` sets the march cost and `tonemap` decides whether the output
// is HDR (High: bloom + composite follow) or display-ready (Low: direct).
struct Params {
  time: f32,
  aspect: f32,
  steps: u32,
  tonemap: u32,
}

@group(0) @binding(0) var<uniform> params: Params;

fn hash(p: vec3f) -> f32 {
  let q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  let r = q + dot(q, q.yxz + 33.33);
  return fract((r.x + r.y) * r.z);
}

fn noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash(i), hash(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(hash(i + vec3f(0.0, 1.0, 0.0)), hash(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(hash(i + vec3f(0.0, 0.0, 1.0)), hash(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(hash(i + vec3f(0.0, 1.0, 1.0)), hash(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

fn fbm(p: vec3f) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    value += amplitude * noise(q);
    q = q * 2.02 + vec3f(1.7, 9.2, 3.1);
    amplitude *= 0.5;
  }
  return value;
}

fn density(p: vec3f, time: f32) -> f32 {
  let drift = vec3f(time * 0.12, time * 0.05, time * 0.08);
  let band = exp(-abs(p.y - 0.35 * sin(p.x * 1.3 + time * 0.4)) * 2.6);
  let ribbons = fbm(p * 1.8 + drift);
  return max(0.0, ribbons - 0.46) * band * 2.0;
}

fn palette(t: f32) -> vec3f {
  let a = vec3f(0.05, 0.35, 0.45);
  let b = vec3f(0.55, 0.25, 0.65);
  let c = vec3f(0.95, 0.55, 0.15);
  return mix(mix(a, b, smoothstep(0.0, 0.6, t)), c, smoothstep(0.55, 1.0, t));
}

fn tonemapAces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let screen = vec2f((uv.x - 0.5) * params.aspect, 0.5 - uv.y) * 2.0;
  let origin = vec3f(0.0, 0.0, -3.0);
  let direction = normalize(vec3f(screen, 1.6));

  let steps = max(params.steps, 4u);
  let stepSize = 5.0 / f32(steps);
  var accumulated = vec3f(0.0);
  var transmittance = 1.0;
  var t = 0.5;
  for (var i = 0u; i < steps; i++) {
    let p = origin + direction * t;
    let d = density(p, params.time);
    if (d > 0.001) {
      let glow = palette(clamp(d * 0.9 + p.y * 0.3 + 0.35, 0.0, 1.0));
      let absorb = exp(-d * stepSize * 1.8);
      accumulated += glow * d * transmittance * stepSize * 1.6;
      transmittance *= absorb;
    }
    t += stepSize;
  }

  let horizon = smoothstep(-1.2, 0.8, screen.y);
  let sky = mix(vec3f(0.02, 0.03, 0.06), vec3f(0.01, 0.015, 0.03), horizon);
  var color = sky * transmittance + accumulated;
  // Sparse star field keeps the frame from reading as flat black on Low.
  let cell = floor(uv * vec2f(160.0, 90.0));
  let seed = hash(vec3f(cell, 7.0));
  let local = fract(uv * vec2f(160.0, 90.0)) - vec2f(hash(vec3f(cell, 11.0)), hash(vec3f(cell, 13.0)));
  let star = step(0.985, seed) * smoothstep(0.08, 0.0, length(local)) * (0.4 + 0.6 * hash(vec3f(cell, 17.0)));
  color += vec3f(star) * 1.2 * transmittance;

  if (params.tonemap == 1u) {
    color = tonemapAces(color);
  }
  return vec4f(color, 1.0);
}

struct Uniforms {
  time: f32,
  resolution: vec2f,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn hash21(p: vec2f) -> f32 {
  let q = fract(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3))));
  return fract(sin(q.x + q.y) * 43758.5453);
}

fn palette(t: f32) -> vec3f {
  let a = vec3f(0.40, 0.20, 0.65);
  let b = vec3f(0.55, 0.35, 0.30);
  let c = vec3f(1.00, 0.85, 0.55);
  let d = vec3f(0.05, 0.30, 0.62);
  return a + b * cos(6.2831853 * (c * t + d));
}

fn orb(p: vec2f, center: vec2f, radius: f32, color: vec3f) -> vec3f {
  let d = length(p - center);
  let core = smoothstep(radius, 0.0, d);
  let halo = radius / max(d, 0.012);
  return color * (core * 1.35 + pow(halo, 1.35) * 0.085);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
  var p = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let t = uniforms.time;

  let radial = length(p);
  var color = mix(vec3f(0.015, 0.020, 0.050), vec3f(0.050, 0.025, 0.110), uv.y);
  color += vec3f(0.015, 0.025, 0.060) * (1.0 - smoothstep(0.0, 0.85, radial));

  let angle = atan2(p.y, p.x);
  let ribbon = 0.5 + 0.5 * sin(angle * 7.0 + radial * 18.0 - t * 1.6);
  color += palette(ribbon * 0.35 + t * 0.03) * pow(ribbon, 7.0) * 0.16 * smoothstep(0.78, 0.08, radial);

  let c0 = vec2f(cos(t * 0.72) * 0.28, sin(t * 0.91) * 0.20);
  let c1 = vec2f(cos(t * -0.58 + 2.1) * 0.34, sin(t * 0.67 + 1.7) * 0.26);
  let c2 = vec2f(cos(t * 0.83 + 4.2) * 0.21, sin(t * -0.76 + 2.9) * 0.33);
  color += orb(p, c0, 0.075, vec3f(1.25, 0.42, 0.95));
  color += orb(p, c1, 0.095, vec3f(0.30, 1.15, 1.35));
  color += orb(p, c2, 0.060, vec3f(1.55, 0.95, 0.30));

  let ringCenter = vec2f(sin(t * 0.37) * 0.08, cos(t * 0.41) * 0.06);
  let ringD = abs(length(p - ringCenter) - (0.31 + 0.035 * sin(t * 0.9)));
  let ring = smoothstep(0.015, 0.0, ringD);
  color += vec3f(0.45, 0.85, 1.6) * ring;

  let star = step(0.995, hash21(floor(uv * uniforms.resolution / 2.25) + floor(t * 8.0)));
  color += vec3f(0.40, 0.55, 0.95) * star * smoothstep(0.25, 0.95, radial);

  let vignette = smoothstep(0.95, 0.18, distance(uv, vec2f(0.5)));
  color *= 0.62 + 0.50 * vignette;

  // The demo intentionally stays on rgba8unorm targets for Docker/Dawn compatibility;
  // the emissive math still creates saturated highlights for an LDR bloom threshold.
  return vec4f(color, 1.0);
}

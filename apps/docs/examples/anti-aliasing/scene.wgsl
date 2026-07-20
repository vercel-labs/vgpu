struct Uniforms {
  time: f32,
  resolution: vec2f,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

const PI: f32 = 3.141592653589793;
const TAU: f32 = 6.283185307179586;

fn hard_line(distance_px: f32, half_width_px: f32) -> f32 {
  return 1.0 - step(half_width_px, abs(distance_px));
}

fn hash21(p: vec2f) -> f32 {
  let q = fract(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3))));
  return fract(sin(q.x + q.y) * 43758.5453);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let res = max(uniforms.resolution, vec2f(1.0));
  let uv = position.xy / res;
  let aspect = res.x / res.y;
  let centered = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let p_px = centered * res.y;
  let radius_px = length(p_px);
  let radius_norm = length(centered);
  let angle = atan2(centered.y, centered.x);

  let rotation = uniforms.time * 0.78;
  let spoke_count = 44.0;
  let spoke_phase = fract((angle + rotation) * spoke_count / TAU + 0.5) - 0.5;
  let spoke_distance_px = abs(spoke_phase) * TAU / spoke_count * max(radius_px, 1.0);
  let spoke_extent = step(10.0, radius_px) * (1.0 - step(min(res.y * 0.47, res.x * 0.47), radius_px));
  let spokes = hard_line(spoke_distance_px, 0.62) * spoke_extent;

  let star_count = 17.0;
  let star_phase = fract((angle - uniforms.time * 1.19) * star_count / TAU + 0.5) - 0.5;
  let star_distance_px = abs(star_phase) * TAU / star_count * max(radius_px, 1.0);
  let star = hard_line(star_distance_px, 1.15) * step(18.0, radius_px) * (1.0 - step(res.y * 0.22, radius_px));

  let ring_phase = fract(radius_px * 0.115 - uniforms.time * 0.34) - 0.5;
  let rings = hard_line(ring_phase, 0.030) * step(res.y * 0.20, radius_px) * (1.0 - step(res.y * 0.48, radius_px));

  let grid_angle = angle + uniforms.time * 0.45;
  let wedge = step(abs(fract(grid_angle / TAU + 0.5) - 0.5), 0.10);
  let diagonal = fract((p_px.x * 0.37 + p_px.y * 0.19) + uniforms.time * 18.0);
  let grating = (1.0 - step(0.23, diagonal)) * wedge * step(res.y * 0.25, radius_px) * (1.0 - step(res.y * 0.46, radius_px));

  let center_disc = 1.0 - step(16.0, radius_px);
  let edge_ring = hard_line(radius_px - min(res.y * 0.485, res.x * 0.485), 1.0);
  let speckle = step(0.985, hash21(floor(position.xy * 0.25) + vec2f(floor(uniforms.time * 8.0)))) * 0.18;

  let white = clamp(max(max(spokes, star), max(rings, max(grating, edge_ring))) + center_disc + speckle, 0.0, 1.0);
  let accent = vec3f(0.08, 0.12, 0.22) * (1.0 - smoothstep(0.0, 0.72, radius_norm));
  let color = mix(accent, vec3f(1.0), white);
  return vec4f(color, 1.0);
}

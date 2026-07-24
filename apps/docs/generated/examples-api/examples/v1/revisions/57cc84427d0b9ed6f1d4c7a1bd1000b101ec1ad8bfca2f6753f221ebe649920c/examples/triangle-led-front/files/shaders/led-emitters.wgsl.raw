struct Config {
  resolution: vec2f,
  time: f32,
  floor_albedo: f32,
  brush: vec4f,
  colour: vec4f,
  tunables: vec4f,
  triangle: vec4f,
  options: vec4f,
  led_clip: vec4f,
};
struct Led {
  pos_brightness: vec4f,
  color: vec4f,
};
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> leds: array<Led>;

struct VSIn {
  @location(0) position: vec2f,
  @location(1) local: vec2f,
  @location(2) led_index: f32,
};
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) led_index: f32,
};

@vertex fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  let clip = (in.position / cfg.resolution) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  out.pos = vec4f(clip, 0.0, 1.0);
  out.local = in.local;
  out.led_index = in.led_index;
  return out;
}

fn signed_triangle_area(a: vec2f, b: vec2f, p: vec2f) -> f32 {
  let edge = b - a;
  return edge.x * (p.y - a.y) - edge.y * (p.x - a.x);
}
fn inside_triangle(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> bool {
  let side0 = signed_triangle_area(a, b, p);
  let side1 = signed_triangle_area(b, c, p);
  let side2 = signed_triangle_area(c, a, p);
  return (side0 <= 0.0 && side1 <= 0.0 && side2 <= 0.0) || (side0 >= 0.0 && side1 >= 0.0 && side2 >= 0.0);
}
fn segment_distance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
fn triangle_sdf(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let edge_dist = min(segment_distance(p, a, b), min(segment_distance(p, b, c), segment_distance(p, c, a)));
  return select(edge_dist, -edge_dist, inside_triangle(p, a, b, c));
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let pixel = in.pos.xy;
  let top = vec2f(cfg.triangle.x, cfg.triangle.y - cfg.triangle.z);
  let left = vec2f(cfg.triangle.x - cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  let right = vec2f(cfg.triangle.x + cfg.triangle.w, cfg.triangle.y + cfg.triangle.z * 0.5);
  let tri_dist = triangle_sdf(pixel, top, left, right);
  // Positive expansion reveals emitter pixels outside the canonical triangle.
  if (tri_dist - cfg.led_clip.x > 0.0) {
    discard;
  }

  let raw_index = u32(max(round(in.led_index), 0.0));
  let i = min(raw_index, arrayLength(&leds) - 1u);
  let n01 = clamp(leds[i].pos_brightness.z, 0.0, 1.0);
  let intensity = mix(cfg.tunables.y, cfg.tunables.z, n01);
  let emit = leds[i].color.rgb * cfg.tunables.x * intensity;
  // Alpha (the LED SDF) is masked off by the pipeline writeMask (0x7 = RGB only) — the fullscreen
  // prepass owns the SDF — so the led_dist that used to go here is never written. Skip computing it.
  return vec4f(emit, 0.0);
}

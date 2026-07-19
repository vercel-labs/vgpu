
struct Config {
  resolution: vec2f,
  time: f32,
  floor_albedo: f32,
  brush: vec4f,
  colour: vec4f,
  tunables: vec4f,
  triangle: vec4f,
  options: vec4f,
};
struct Led {
  pos_brightness: vec4f,
  color: vec4f,
};
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> leds: array<Led>;
struct VSOut { @builtin(position) pos: vec4f };
const LED_COUNT: u32 = 72u;
// Keep LED emission and the black occluder safely inside the visible triangle mesh.
const LED_CLIP_INSET_PX: f32 = 2.0;
const OCCLUDER_INSET_PX: f32 = 4.0;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut; out.pos = vec4f(p[vi], 0.0, 1.0); return out;
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
  // Layer 1: optionally fill the canonical triangle interior as a black non-emissive surface/occluder.
  // Layer 2 below lets clipped LED pixels override this surface with emissive RGB.
  let render_black_occluder = cfg.options.x > 0.5;
  var best_led_dist = 1e6;
  var emit = vec3f(0.0);
  for (var i = 0u; i < LED_COUNT; i = i + 1u) {
    let led = leds[i].pos_brightness;
    let delta = pixel - led.xy;
    let edge_dir = vec2f(cos(led.w), sin(led.w));
    let edge_normal = vec2f(-edge_dir.y, edge_dir.x);
    let led_local = vec2f(dot(delta, edge_dir), dot(delta, edge_normal));
    let led_radius = cfg.tunables.w;
    let led_dist = max(abs(led_local.x), abs(led_local.y)) - led_radius * 2.;
    // triangle_sdf is negative inside; adding 2px moves only the LED clip boundary inward.
    let led_clip_dist = tri_dist + LED_CLIP_INSET_PX;
    let clipped_led_dist = max(led_dist, led_clip_dist);
    if (clipped_led_dist < best_led_dist) {
      best_led_dist = clipped_led_dist;
      let n01 = clamp(led.z, 0., 1.);
      let intensity = mix(cfg.tunables.y, cfg.tunables.z, n01);
      emit = leds[i].color.rgb * cfg.tunables.x * intensity;
    }
  }
  // triangle_sdf is negative inside; adding 4px moves only the black occluder boundary inward.
  let inset_occluder_dist = tri_dist + OCCLUDER_INSET_PX;
  let occluder_dist = select(1e6, inset_occluder_dist, render_black_occluder);
  let best_dist = min(best_led_dist, occluder_dist);
  let led_hit = best_led_dist <= cfg.options.y;
  // triangle-led-4 does not inject the cursor into the production SDF/color buffer as a black brush.
  return vec4f(select(vec3f(0.0), emit, led_hit), best_dist);
}

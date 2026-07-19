import { CascadeInfo, angle_from, cascade_info, probe_aabb, probe_index, ray_dir } from "./cascade-utils.wgsl";
import { ray_intersects_aabb } from "./ray-aabb.wgsl";
import { ray_hits_edge } from "./ray-segment.wgsl";

// These early-outs are valid while the LED triangle is the sole emitter.
// If an off-triangle emitter is added, expand/recompute this AABB or remove the early-outs.
const TRIANGLE_HEIGHT_RATIO: f32 = 0.3;
const SQRT3: f32 = 1.7320508075688772;
struct Config { scene: vec4f, cascade: vec4f, params: vec4f, culling: vec4f, fit: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var sdf_tex: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut; out.pos = vec4f(p[vi], 0.0, 1.0); return out;
}
fn distance_to_aabb(p: vec2f, box_min: vec2f, box_max: vec2f) -> f32 {
  let d = max(max(box_min - p, p - box_max), vec2f(0.0));
  return length(d);
}
fn sample_radiance(origin: vec2f, dir: vec2f, ci: CascadeInfo) -> vec4f {
  var t = ci.range.x;
  for (var i = 0; i < 32; i++) {
    let p = origin + t * dir;
    if (t > ci.range.y) { break; }
    if (p.x < 0.0 || p.x > cfg.scene.x - 1.0 || p.y < 0.0 || p.y > cfg.scene.y - 1.0) { break; }
    let s = textureLoad(sdf_tex, vec2i(p), 0);
    if (s.w > 0.1) { t += s.w; continue; }
    return vec4f(s.rgb, 0.0);
  }
  return vec4f(vec3f(0.0), 1.0);
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let pixel = in.pos.xy - vec2f(0.5);
  let ci = cascade_info(cfg.params, i32(cfg.params.z));
  let aabb = probe_aabb(probe_index(pixel, ci), ci);
  let coords = vec2i(pixel - aabb.minp);
  let angle = angle_from(coords, ci);
  let dir = ray_dir(angle);
  let origin = cfg.fit.xy + aabb.center * cfg.scene.xy / cfg.fit.zw;

  let tri_height = cfg.scene.y * TRIANGLE_HEIGHT_RATIO;
  let tri_half_side = tri_height / SQRT3;
  let scene_center = cfg.scene.xy * 0.5;
  let light_aabb_padding = cfg.culling.x;
  let probe_discard_distance = cfg.culling.y;
  let led_radius = cfg.culling.z;
  let led_hit_threshold = cfg.culling.w;
  let top = vec2f(scene_center.x, scene_center.y - tri_height * (2.0 / 3.0));
  let left = vec2f(scene_center.x - tri_half_side, scene_center.y + tri_height / 3.0);
  let right = vec2f(scene_center.x + tri_half_side, scene_center.y + tri_height / 3.0);
  let light_min = vec2f(
    left.x - light_aabb_padding,
    top.y - light_aabb_padding,
  );
  let light_max = vec2f(
    right.x + light_aabb_padding,
    left.y + light_aabb_padding,
  );
  let light_aabb_size = light_max - light_min;
  let discard_margin_px = probe_discard_distance * 1.5 * max(light_aabb_size.x, light_aabb_size.y);
  if (distance_to_aabb(origin, light_min, light_max) > discard_margin_px) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  if (!ray_intersects_aabb(origin, dir, light_min, light_max, ci.range.x, ci.range.y)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let edge_radius = 2.0 * led_radius + led_hit_threshold + light_aabb_padding;
  let hits_padded_edge =
    ray_hits_edge(origin, dir, ci.range.x, ci.range.y, top, left, edge_radius) ||
    ray_hits_edge(origin, dir, ci.range.x, ci.range.y, left, right, edge_radius) ||
    ray_hits_edge(origin, dir, ci.range.x, ci.range.y, right, top, edge_radius);
  if (!hits_padded_edge) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  return sample_radiance(origin, dir, ci);
}

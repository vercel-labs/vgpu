import { angle_from, cascade_info, probe_aabb, probe_index } from "./cascade-utils.wgsl";
import { merged_bilinear } from "./sample-dir.wgsl";

// Mirrors the build-pass light AABB used for probe discard. Merge must repeat
// the probe-level discard so a discarded lower-cascade probe cannot reintroduce
// radiance from a coarser cascade during the merge step.
const TRIANGLE_HEIGHT_RATIO: f32 = 0.3;
const SQRT3: f32 = 1.7320508075688772;

struct Config { scene: vec4f, cascade: vec4f, params: vec4f, culling: vec4f, fit: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var real_tex: texture_2d<f32>;
@group(0) @binding(2) var next_tex: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut; out.pos = vec4f(p[vi], 0.0, 1.0); return out;
}
fn distance_to_aabb(p: vec2f, box_min: vec2f, box_max: vec2f) -> f32 {
  let d = max(max(box_min - p, p - box_max), vec2f(0.0));
  return length(d);
}
fn outside_probe_discard_margin(origin: vec2f) -> bool {
  let tri_height = cfg.scene.y * TRIANGLE_HEIGHT_RATIO;
  let tri_half_side = tri_height / SQRT3;
  let scene_center = cfg.scene.xy * 0.5;
  let light_aabb_padding = cfg.culling.x;
  let probe_discard_distance = cfg.culling.y;
  let light_min = vec2f(
    scene_center.x - tri_half_side - light_aabb_padding,
    scene_center.y - tri_height * (2.0 / 3.0) - light_aabb_padding,
  );
  let light_max = vec2f(
    scene_center.x + tri_half_side + light_aabb_padding,
    scene_center.y + tri_height / 3.0 + light_aabb_padding,
  );
  let light_aabb_size = light_max - light_min;
  let discard_margin_px = probe_discard_distance * 1.5 * max(light_aabb_size.x, light_aabb_size.y);
  return distance_to_aabb(origin, light_min, light_max) > discard_margin_px;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let pixel = in.pos.xy - vec2f(0.5); let level = i32(cfg.params.z);
  let ci = cascade_info(cfg.params, level); let box = probe_aabb(probe_index(pixel, ci), ci);
  let origin = cfg.fit.xy + box.center * cfg.scene.xy / cfg.fit.zw;
  if (outside_probe_discard_margin(origin)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let angle = angle_from(vec2i(pixel - box.minp), ci);
  var radiance = textureLoad(real_tex, vec2i(pixel), 0);
  if (level + 1 <= i32(cfg.params.w) - 1) { let s = merged_bilinear(next_tex, cfg.cascade.xy, cfg.params, pixel, angle, level + 1); radiance = vec4f(radiance.rgb + s.rgb * radiance.a, radiance.a * s.a); }
  return radiance;
}

import { CascadeInfo, angle_to_index, cascade_info, idx_to_cascade, probe_aabb, probe_index } from "./cascade-utils.wgsl";

const PI: f32 = 3.14159265359;

export fn sample_dir(next_tex: texture_2d<f32>, cascade_size: vec2f, params: vec4f, cascade_idx: vec2i, level: i32, angle: f32) -> vec4f {
  let ci = cascade_info(params, level);
  let box = probe_aabb(cascade_idx, ci);
  if (box.center.x < 0.0 || box.center.x >= cascade_size.x || box.center.y < 0.0 || box.center.y >= cascade_size.y) {
    return vec4f(0.0);
  }

  let base = angle_to_index(angle + PI / f32(ci.angles), ci);
  var radiance = vec4f(0.0);
  for (var i = 0; i < 4; i++) {
    let ai = idx_to_cascade(base + i - 1, ci);
    radiance += textureLoad(next_tex, vec2i(box.minp) + ai, 0);
  }
  return radiance * 0.25;
}

export fn merged_bilinear(next_tex: texture_2d<f32>, cascade_size: vec2f, params: vec4f, pixel: vec2f, angle: f32, level: i32) -> vec4f {
  let ci = cascade_info(params, level);
  let lower = cascade_info(params, level - 1);
  let lower_box = probe_aabb(probe_index(pixel, lower), lower);
  let pos = lower_box.center - f32(ci.dims) * 0.5;
  let bl_probe = probe_index(pos, ci);
  let bl_box = probe_aabb(bl_probe, ci);
  let center = bl_box.center;
  let st = (lower_box.center - center) / f32(ci.dims);
  let w = fract(st);
  let step = f32(ci.dims);
  let r00 = sample_dir(next_tex, cascade_size, params, probe_index(center, ci), level, angle);
  let r10 = sample_dir(next_tex, cascade_size, params, probe_index(center + vec2f(step, 0.0), ci), level, angle);
  let r01 = sample_dir(next_tex, cascade_size, params, probe_index(center + vec2f(0.0, step), ci), level, angle);
  let r11 = sample_dir(next_tex, cascade_size, params, probe_index(center + vec2f(step), ci), level, angle);
  return mix(mix(r00, r10, w.x), mix(r01, r11, w.x), w.y);
}

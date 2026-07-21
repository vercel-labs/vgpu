import { Grid, Input, index_of, cell_uv, segment_weight, emitter_weight } from "./fluid-common.wgsl";

@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> input: Input;
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;

fn sample_dye(p: vec2f) -> vec4f {
  let coord = clamp(p * vec2f(grid.dye_size) - 0.5, vec2f(0), vec2f(grid.dye_size) - 1.0);
  let cell = vec2i(floor(coord));
  let f = fract(coord);
  let bottom = mix(src[index_of(cell, grid.dye_size)], src[index_of(cell + vec2i(1, 0), grid.dye_size)], f.x);
  let top = mix(src[index_of(cell + vec2i(0, 1), grid.dye_size)], src[index_of(cell + vec2i(1, 1), grid.dye_size)], f.x);
  return mix(bottom, top, f.y);
}

fn sample_velocity(p: vec2f) -> vec2f {
  let coord = clamp(p * vec2f(grid.size) - 0.5, vec2f(0), vec2f(grid.size) - 1.0);
  let cell = vec2i(floor(coord));
  let f = fract(coord);
  let bottom = mix(velocity[index_of(cell, grid.size)], velocity[index_of(cell + vec2i(1, 0), grid.size)], f.x);
  let top = mix(velocity[index_of(cell + vec2i(0, 1), grid.size)], velocity[index_of(cell + vec2i(1, 1), grid.size)], f.x);
  return mix(bottom, top, f.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= grid.dye_size)) { return; }
  let cell = vec2i(id.xy);
  let p = cell_uv(cell, grid.dye_size);
  let aspect = f32(grid.size.x) / f32(grid.size.y);
  let backtrace = clamp(p - sample_velocity(p) / 60.0, 0.5 / vec2f(grid.dye_size), 1.0 - 0.5 / vec2f(grid.dye_size));
  var color = 0.97 * sample_dye(backtrace);

  color += vec4f(0.05, 0.48, 1.0, 1.0) * emitter_weight(p, input.idle_a, aspect) * 0.12;
  color += vec4f(1.0, 0.08, 0.55, 1.0) * emitter_weight(p, input.idle_b, aspect) * 0.115;
  if (input.pointer_active > 0.0) {
    let weight = segment_weight(p, input.pointer_from, input.pointer_to, 0.002, aspect);
    color += input.pointer_color * weight * 0.35;
  }

  dst[index_of(cell, grid.dye_size)] = clamp(color, vec4f(0), vec4f(4));
}

import { Grid, Input, index_of, cell_uv, segment_weight, emitter_weight } from "./fluid-common.wgsl";

@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> input: Input;
@group(0) @binding(2) var<storage, read> src: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2f>;

fn sample_velocity(p: vec2f) -> vec2f {
  let coord = clamp(p * vec2f(grid.size) - 0.5, vec2f(0), vec2f(grid.size) - 1.0);
  let cell = vec2i(floor(coord));
  let f = fract(coord);
  let bottom = mix(src[index_of(cell, grid.size)], src[index_of(cell + vec2i(1, 0), grid.size)], f.x);
  let top = mix(src[index_of(cell + vec2i(0, 1), grid.size)], src[index_of(cell + vec2i(1, 1), grid.size)], f.x);
  return mix(bottom, top, f.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= grid.size)) { return; }
  let cell = vec2i(id.xy);
  let p = cell_uv(cell, grid.size);
  let aspect = f32(grid.size.x) / f32(grid.size.y);
  let dt = 1.0 / 60.0;
  let source_velocity = src[index_of(cell, grid.size)];
  let backtrace = clamp(p - dt * source_velocity, 0.5 / vec2f(grid.size), 1.0 - 0.5 / vec2f(grid.size));
  var velocity = 0.98 * sample_velocity(backtrace);

  let weight_a = emitter_weight(p, input.idle_a, aspect);
  let weight_b = emitter_weight(p, input.idle_b, aspect);
  let time = f32(input.step) / 60.0;
  let tangent_a = vec2f(0.28 * 0.73 * cos(0.73 * time), 0.22 * 1.09 * cos(1.09 * time + 0.4));
  let tangent_b = vec2f(0.26 * 0.61 * cos(0.61 * time + 3.14159265), 0.24 * 0.97 * cos(0.97 * time + 2.1));
  velocity += dt * (weight_a * (2.6 * tangent_a + 2.0 * vec2f(-tangent_a.y, tangent_a.x))
                  + weight_b * (2.6 * tangent_b - 2.0 * vec2f(-tangent_b.y, tangent_b.x)));

  if (input.pointer_active > 0.0) {
    let weight = segment_weight(p, input.pointer_from, input.pointer_to, 0.002, aspect);
    velocity += weight * input.pointer_velocity * 0.8;
  }

  let speed = length(velocity);
  if (speed > 2.5) { velocity *= 2.5 / speed; }
  dst[index_of(cell, grid.size)] = velocity;
}

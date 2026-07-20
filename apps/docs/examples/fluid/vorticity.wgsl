import { Grid, index_of } from "./fluid-common.wgsl";

@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read> curl: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= grid.size)) { return; }
  let p = vec2i(id.xy);
  let left = abs(curl[index_of(p - vec2i(1, 0), grid.size)]);
  let right = abs(curl[index_of(p + vec2i(1, 0), grid.size)]);
  let top = abs(curl[index_of(p + vec2i(0, 1), grid.size)]);
  let bottom = abs(curl[index_of(p - vec2i(0, 1), grid.size)]);
  let center = curl[index_of(p, grid.size)];

  var force = 0.5 * vec2f(top - bottom, right - left);
  force /= length(force) + 0.0001;
  force *= 20.0 * center;
  force.y *= -1.0;

  var velocity = src[index_of(p, grid.size)] + force / 60.0;
  let speed = length(velocity);
  if (speed > 2.5) { velocity *= 2.5 / speed; }
  dst[index_of(p, grid.size)] = velocity;
}

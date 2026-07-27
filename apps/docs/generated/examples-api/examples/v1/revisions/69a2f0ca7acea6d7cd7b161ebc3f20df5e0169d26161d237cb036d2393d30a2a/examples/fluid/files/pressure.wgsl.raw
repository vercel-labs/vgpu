import { Grid, index_of } from "./fluid-common.wgsl";

struct PressureParams { decay: f32, _pad: vec3f }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> params: PressureParams;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read> divergence: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= grid.size)) { return; }
  let p = vec2i(id.xy);
  let i = index_of(p, grid.size);
  let center = src[i];
  let last = vec2i(grid.size) - 1;
  let left = select(src[index_of(p - vec2i(1, 0), grid.size)], center, p.x == 0) * params.decay;
  let right = select(src[index_of(p + vec2i(1, 0), grid.size)], center, p.x == last.x) * params.decay;
  let bottom = select(src[index_of(p - vec2i(0, 1), grid.size)], center, p.y == 0) * params.decay;
  let top = select(src[index_of(p + vec2i(0, 1), grid.size)], center, p.y == last.y) * params.decay;
  let wx = f32(grid.size.x * grid.size.x);
  let wy = f32(grid.size.y * grid.size.y);
  dst[i] = ((left + right) * wx + (bottom + top) * wy - divergence[i]) / (2.0 * wx + 2.0 * wy);
}

// Velocity divergence. A neighbour across a wall mirrors the centre's normal
// component, so no fluid flows through the edges.

import { Grid } from "./fluid-common.wgsl";

@group(0) @binding(0) var velocity: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> grid: Grid;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dx = vec2f(grid.texel.x, 0.0);
  let dy = vec2f(0.0, grid.texel.y);
  let here = textureSampleLevel(velocity, samp, uv, 0.0).xy;
  let cell = uv * grid.size;
  let left = select(textureSampleLevel(velocity, samp, uv - dx, 0.0).x, -here.x, cell.x < 1.0);
  let right = select(textureSampleLevel(velocity, samp, uv + dx, 0.0).x, -here.x, cell.x > grid.size.x - 1.0);
  let up = select(textureSampleLevel(velocity, samp, uv - dy, 0.0).y, -here.y, cell.y < 1.0);
  let down = select(textureSampleLevel(velocity, samp, uv + dy, 0.0).y, -here.y, cell.y > grid.size.y - 1.0);
  return vec4f(0.5 * (right - left + down - up), 0.0, 0.0, 1.0);
}

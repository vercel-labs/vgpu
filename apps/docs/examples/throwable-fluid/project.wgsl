// Subtracts the pressure gradient, leaving a divergence-free velocity field.

import { Grid, wall_mask } from "./fluid-common.wgsl";

@group(0) @binding(0) var velocity: texture_2d<f32>;
@group(0) @binding(1) var pressure: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> grid: Grid;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dx = vec2f(grid.texel.x, 0.0);
  let dy = vec2f(0.0, grid.texel.y);
  let left = textureSampleLevel(pressure, samp, uv - dx, 0.0).x;
  let right = textureSampleLevel(pressure, samp, uv + dx, 0.0).x;
  let up = textureSampleLevel(pressure, samp, uv - dy, 0.0).x;
  let down = textureSampleLevel(pressure, samp, uv + dy, 0.0).x;
  let projected = textureSampleLevel(velocity, samp, uv, 0.0).xy - 0.5 * vec2f(right - left, down - up);
  return vec4f(projected * wall_mask(uv, grid), 0.0, 1.0);
}

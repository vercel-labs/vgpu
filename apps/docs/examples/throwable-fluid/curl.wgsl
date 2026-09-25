// Vorticity of the velocity field, read back by the next advection for
// confinement.

import { Grid } from "./fluid-common.wgsl";

@group(0) @binding(0) var velocity: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> grid: Grid;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dx = vec2f(grid.texel.x, 0.0);
  let dy = vec2f(0.0, grid.texel.y);
  let left = textureSampleLevel(velocity, samp, uv - dx, 0.0).y;
  let right = textureSampleLevel(velocity, samp, uv + dx, 0.0).y;
  let up = textureSampleLevel(velocity, samp, uv - dy, 0.0).x;
  let down = textureSampleLevel(velocity, samp, uv + dy, 0.0).x;
  return vec4f(0.5 * ((right - left) - (down - up)), 0.0, 0.0, 1.0);
}

// One Jacobi iteration of the pressure Poisson equation. The first iteration
// of a step scales last step's pressure by `warm` as its starting guess.

import { Grid } from "./fluid-common.wgsl";

struct Jacobi {
  warm: f32,
}

@group(0) @binding(0) var pressure: texture_2d<f32>;
@group(0) @binding(1) var divergence: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> grid: Grid;
@group(0) @binding(4) var<uniform> jacobi: Jacobi;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dx = vec2f(grid.texel.x, 0.0);
  let dy = vec2f(0.0, grid.texel.y);
  let neighbours = textureSampleLevel(pressure, samp, uv - dx, 0.0).x
    + textureSampleLevel(pressure, samp, uv + dx, 0.0).x
    + textureSampleLevel(pressure, samp, uv - dy, 0.0).x
    + textureSampleLevel(pressure, samp, uv + dy, 0.0).x;
  let div = textureSampleLevel(divergence, samp, uv, 0.0).x;
  return vec4f((neighbours * jacobi.warm - div) * 0.25, 0.0, 0.0, 1.0);
}

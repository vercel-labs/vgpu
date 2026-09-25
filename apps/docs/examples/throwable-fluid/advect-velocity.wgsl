// Semi-Lagrangian velocity advection plus every force of one step:
// vorticity confinement, explicit viscous diffusion, the orb dragging the
// fluid along its swept segment, and a splash: the fluid thrown back off a
// wall and spread along it, or a swirl around the orb.

import { Grid, capsule_distance, wall_mask } from "./fluid-common.wgsl";

struct Stir {
  // The orb's swept segment this step, in uv.
  segmentStart: vec2f,
  segmentEnd: vec2f,
  // Orb velocity in grid texels per second.
  orbVelocity: vec2f,
  splashCenter: vec2f,
  // Grid texels per second thrown back into the field at the splash.
  splashJet: vec2f,
  // Canvas-height units.
  radius: f32,
  // Share of the fluid velocity pulled to the orb's at the segment (0..1).
  drag: f32,
  splashRadius: f32,
  // Grid texels per second of swirl one splash radius from its centre.
  splashSwirl: f32,
  aspect: f32,
  dt: f32,
  vorticity: f32,
  viscosity: f32,
  dissipation: f32,
  maxSpeed: f32,
}

@group(0) @binding(0) var velocity: texture_2d<f32>;
@group(0) @binding(1) var curl: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> grid: Grid;
@group(0) @binding(4) var<uniform> stir: Stir;

// How strongly a splash also spreads the fluid sideways along the wall.
const SPREAD = 1.2;

fn vel(p: vec2f) -> vec2f {
  return textureSampleLevel(velocity, samp, p, 0.0).xy;
}

fn spin(p: vec2f) -> f32 {
  return textureSampleLevel(curl, samp, p, 0.0).x;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dx = vec2f(grid.texel.x, 0.0);
  let dy = vec2f(0.0, grid.texel.y);
  let here = vel(uv);
  var next = vel(uv - stir.dt * here * grid.texel);

  // Viscosity: one explicit diffusion step, stable while the weight stays under 0.25.
  let laplacian = vel(uv - dx) + vel(uv + dx) + vel(uv - dy) + vel(uv + dy) - 4.0 * here;
  next += stir.viscosity * laplacian;

  // Vorticity confinement pushes along the curl's level lines, restoring small eddies.
  let omega = spin(uv);
  var toward = 0.5 * vec2f(abs(spin(uv + dx)) - abs(spin(uv - dx)), abs(spin(uv + dy)) - abs(spin(uv - dy)));
  toward = toward / (length(toward) + 1e-4);
  next += stir.vorticity * omega * vec2f(toward.y, -toward.x) * stir.dt;

  next = next / (1.0 + stir.dissipation * stir.dt);

  // The orb: a soft capsule over its swept segment pulls the fluid toward its own velocity.
  let d = capsule_distance(uv, stir.segmentStart, stir.segmentEnd, stir.aspect);
  let w = exp(-(d * d) / (stir.radius * stir.radius));
  next = mix(next, stir.orbVelocity, saturate(w * stir.drag));

  // A splash. A jet back off the wall rolls up into a mushroom-shaped vortex
  // pair, and the sideways spread sends a curl along the wall on each side
  // (a purely radial push would be projected away). A ripple is a swirl.
  let offset = (uv - stir.splashCenter) * vec2f(stir.aspect, 1.0) / max(stir.splashRadius, 1e-4);
  let fall = exp(-dot(offset, offset));
  let jet = length(stir.splashJet);
  let side = vec2f(-stir.splashJet.y, stir.splashJet.x) / max(jet, 1e-5);
  next += (stir.splashJet + side * dot(offset, side) * jet * SPREAD) * fall;
  next += vec2f(-offset.y, offset.x) * stir.splashSwirl * fall;

  let speed = length(next);
  next = next * min(1.0, stir.maxSpeed / max(speed, 1e-5));
  return vec4f(next * wall_mask(uv, grid), 0.0, 1.0);
}

// Carries the dye along the projected velocity, fades it, and adds this
// step's ink: a soft band along the orb's swept segment (brighter towards its
// rim, so fast throws leave two streaks that curl into the wake) and the
// burst of a splash, which its jet then carries off the wall, or the arms of
// a ripple, which its swirl winds into a spiral.

import { Grid, capsule_distance } from "./fluid-common.wgsl";

struct Ink {
  segmentStart: vec2f,
  segmentEnd: vec2f,
  splashCenter: vec2f,
  // Canvas-height units.
  radius: f32,
  amount: f32,
  color: vec3f,
  splashAmount: f32,
  splashColor: vec3f,
  splashRadius: f32,
  // 0 for a round burst, else the number of arms laid around the centre.
  splashArms: f32,
  splashTurn: f32,
  aspect: f32,
  dt: f32,
  dissipation: f32,
}

@group(0) @binding(0) var dye: texture_2d<f32>;
@group(0) @binding(1) var velocity: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> grid: Grid;
@group(0) @binding(4) var<uniform> ink: Ink;

@fragment fn fs_main(@location(0) texel_uv: vec2f) -> @location(0) vec4f {
  // Dye within one grid cell of a wall copies the dye one cell in. The flow
  // there never carries ink off the wall, so that band would otherwise keep
  // every splash for good and feed it back into each backtrace that clamps
  // onto the edge: a bright seam. (The dye is at least 2x finer than the grid.)
  let uv = clamp(texel_uv, grid.texel, 1.0 - grid.texel);
  let flow = textureSampleLevel(velocity, samp, uv, 0.0).xy;
  var color = textureSampleLevel(dye, samp, uv - ink.dt * flow * grid.texel, 0.0).rgb;
  color = color / (1.0 + ink.dissipation * ink.dt);

  let q = capsule_distance(uv, ink.segmentStart, ink.segmentEnd, ink.aspect) / max(ink.radius, 1e-4);
  let band = exp(-3.0 * q * q) * (0.25 + 3.0 * q * q);
  color += ink.color * ink.amount * band;

  let rel = (uv - ink.splashCenter) * vec2f(ink.aspect, 1.0) / max(ink.splashRadius, 1e-4);
  let r = length(rel);
  var burst = exp(-r * r * 2.5);
  if (ink.splashArms > 0.0) {
    let around = 0.5 + 0.5 * cos(atan2(rel.y, rel.x) * ink.splashArms + ink.splashTurn);
    let ring = (r - 0.95) / 0.22;
    burst = exp(-ring * ring) * pow(around, 6.0);
  }
  color += ink.splashColor * ink.splashAmount * burst;

  return vec4f(min(color, vec3f(4.0)), 1.0);
}

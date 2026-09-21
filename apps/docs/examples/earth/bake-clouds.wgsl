// Bakes procedural cloud coverage into an r8unorm map.

import { belt, equirectDirection, fbm3, fbmVector, ridged3, saturate, valueRemap } from "./planet-common.wgsl";

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direction = equirectDirection(uv);
  let latitude = direction.y;

  let flow = latitude * 0.35;
  let sheared = vec3f(
    direction.x * cos(flow) - direction.z * sin(flow),
    direction.y,
    direction.x * sin(flow) + direction.z * cos(flow),
  );
  let swirl = fbmVector(sheared * 1.9 + vec3f(17.3, -5.1, 42.7), 3) * 0.40;

  let systems = fbm3(sheared * 2.8 + swirl, 6);
  let wisps = fbm3(sheared * 7.5 + swirl * 1.6, 5);
  let filaments = ridged3(sheared * 16.0 + swirl * 2.2, 4) * 2.0 - 1.0;
  let field = systems * 0.70 + wisps * 0.45 + filaments * 0.16;

  let jitter = fbm3(direction * 1.15 + vec3f(71.0, 13.0, -29.0), 3) * 0.10;
  let lane = abs(latitude) + jitter;
  let weather = 0.30
    + belt(lane, 0.00, 0.15) * 0.30   // intertropical convergence
    + belt(lane, 0.64, 0.30) * 0.26   // mid-latitude storm tracks
    + belt(lane, 0.97, 0.24) * 0.16   // polar cloud
    - belt(lane, 0.34, 0.20) * 0.30;  // subtropical highs, where the deserts sit

  let raw = saturate(valueRemap(field + (weather - 0.46) * 0.85, -0.24, 0.62, 0.0, 1.0));
  return vec4f(pow(raw, 2.4), 0.0, 0.0, 1.0);
}

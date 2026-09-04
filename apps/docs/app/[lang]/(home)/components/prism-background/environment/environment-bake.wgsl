// Bakes either authored analytic environment into the same equirectangular HDR
// texture layout used by the environment-map and transmission examples.

import { sampleDebugEnvironment } from "./environment-debug-map.wgsl";
import { direction_from_equirect } from "./environment-map-common.wgsl";
import { sampleStudioEnvironment } from "./environment.wgsl";

struct BakeParams {
  debug: f32,
}

@group(0) @binding(0) var<uniform> params: BakeParams;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direction = direction_from_equirect(uv);
  if (params.debug > 0.5) {
    return vec4f(sampleDebugEnvironment(direction), 1.0);
  }
  return vec4f(sampleStudioEnvironment(direction), 1.0);
}

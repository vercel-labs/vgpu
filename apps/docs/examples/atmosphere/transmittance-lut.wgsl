import { Atmosphere, raySphere, sampleMedium, transmittanceParams } from "./atmosphere-common.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;

const STEPS: f32 = 40.0;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = atmosphere;
  let params = transmittanceParams(p, uv);
  let origin = vec3f(0.0, params.viewHeight, 0.0);
  let dir = vec3f(sqrt(max(0.0, 1.0 - params.viewZenithCos * params.viewZenithCos)), params.viewZenithCos, 0.0);
  let tTop = raySphere(origin, dir, p.atmosphereRadius);
  if (tTop <= 0.0) { return vec4f(1.0); }
  let dt = tTop / STEPS;
  var opticalDepth = vec3f(0.0);
  for (var i = 0.0; i < STEPS; i += 1.0) {
    let position = origin + (i + 0.5) * dt * dir;
    opticalDepth += sampleMedium(p, position).extinction * dt;
  }
  return vec4f(exp(-opticalDepth), 1.0);
}

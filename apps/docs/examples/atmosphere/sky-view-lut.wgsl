import { Atmosphere, Camera, integrateScattering, meanTransmittance, skyViewParams } from "./atmosphere-common.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multiScatterLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;

/** Camera-relative sky, lat-long with the horizon folded to v = 0.5. Alpha keeps the mean transmittance. */
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = atmosphere;
  let viewHeight = length(camera.position);
  let params = skyViewParams(p, viewHeight, uv);
  let up = camera.position / viewHeight;
  let sunZenithCos = dot(p.sunDirection, up);
  let sunDir = normalize(vec3f(sqrt(saturate(1.0 - sunZenithCos * sunZenithCos)), sunZenithCos, 0.0));
  let viewZenithSin = sqrt(saturate(1.0 - params.viewZenithCos * params.viewZenithCos));
  let lightViewSin = sqrt(saturate(1.0 - params.lightViewCos * params.lightViewCos));
  let dir = vec3f(viewZenithSin * params.lightViewCos, params.viewZenithCos, viewZenithSin * lightViewSin);
  let origin = vec3f(0.0, viewHeight, 0.0);
  let result = integrateScattering(p, origin, dir, sunDir, 9e9, 30.0, true, false, true, transmittanceLut, multiScatterLut, lutSampler);
  return vec4f(result.luminance, meanTransmittance(result.transmittance));
}

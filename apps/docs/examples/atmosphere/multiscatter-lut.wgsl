import { Atmosphere, MULTISCATTER_LUT_SIZE, PI, PLANET_RADIUS_OFFSET, fromSubUvsToUnit, integrateScattering } from "./atmosphere-common.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var multiScatterLut: texture_storage_2d<rgba16float, write>;

const DIRECTIONS: u32 = 64u;
const SQRT_DIRECTIONS: f32 = 8.0;

var<workgroup> sharedLuminance: array<vec3f, 64>;
var<workgroup> sharedMultiScat: array<vec3f, 64>;

/** One workgroup per texel; each of the 64 threads integrates one direction on the unit sphere. */
@compute @workgroup_size(1, 1, 64)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let p = atmosphere;
  let uv = vec2f(
    fromSubUvsToUnit((f32(id.x) + 0.5) / MULTISCATTER_LUT_SIZE, MULTISCATTER_LUT_SIZE),
    fromSubUvsToUnit((f32(id.y) + 0.5) / MULTISCATTER_LUT_SIZE, MULTISCATTER_LUT_SIZE),
  );
  let sunZenithCos = clamp(uv.x * 2.0 - 1.0, -1.0, 1.0);
  let viewHeight = p.groundRadius + saturate(uv.y + PLANET_RADIUS_OFFSET) * (p.atmosphereRadius - p.groundRadius);
  let sunDir = normalize(vec3f(0.0, sunZenithCos, -sqrt(saturate(1.0 - sunZenithCos * sunZenithCos))));
  let origin = vec3f(0.0, viewHeight, 0.0);

  let i = f32(local.z % 8u);
  let j = f32(local.z / 8u);
  let theta = 2.0 * PI * (i + 0.5) / SQRT_DIRECTIONS;
  let phi = acos(1.0 - 2.0 * (j + 0.5) / SQRT_DIRECTIONS);
  let dir = vec3f(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));

  let result = integrateScattering(p, origin, dir, sunDir, 9e9, 20.0, false, true, false, transmittanceLut, transmittanceLut, lutSampler);
  // Sphere solid angle (4pi) / 64 directions, then the isotropic phase 1/(4pi): net 1/64.
  sharedLuminance[local.z] = result.luminance / f32(DIRECTIONS);
  sharedMultiScat[local.z] = result.multiScatAs1 / f32(DIRECTIONS);
  workgroupBarrier();

  if (local.z != 0u) { return; }
  var luminance = vec3f(0.0);
  var multiScatAs1 = vec3f(0.0);
  for (var k = 0u; k < DIRECTIONS; k += 1u) {
    luminance += sharedLuminance[k];
    multiScatAs1 += sharedMultiScat[k];
  }
  // Infinite geometric series of scattering orders: L * (1 + r + r^2 + ...) = L / (1 - r).
  let contribution = 1.0 / max(vec3f(1e-4), 1.0 - multiScatAs1);
  textureStore(multiScatterLut, id.xy, vec4f(luminance * contribution, 1.0));
}

import { remap } from "./noise-common.wgsl";
import { SunShadow } from "./atmosphere-common.wgsl";

/** Cloud layer description shared by the cloud raymarch and the cloud shadow map. Distances in km. */
export struct Clouds {
  bottom: f32, top: f32, coverage: f32, density: f32,
  shapeScale: f32, detailScale: f32, weatherScale: f32, wind: f32,
  detailStrength: f32, groundRadius: f32, curlStrength: f32, detailLodDistance: f32,
  /** shadows: 1 when the clouds shade the terrain and the air (cloud-shadow.wgsl), 0 to switch that off. */
  typeBias: f32, seed: f32, shadows: f32, pad1: f32,
};

/** The cloud shadow map (cloud-shadow.wgsl) covers the far shadow cascade's window at this resolution. */
export const CLOUD_SHADOW_MAP_SIZE: f32 = 512.0;

/** Mean of the detail fbm over the noise volume (measured 0.494 over the 32-cube): what the erosion applies where its pattern has faded out. */
const DETAIL_FBM_MEAN: f32 = 0.5;

export fn heightFraction(c: Clouds, altitude: f32) -> f32 {
  return saturate((altitude - c.bottom) / (c.top - c.bottom));
}

export fn sampleWeather(weather: texture_2d<f32>, weatherSampler: sampler, c: Clouds, xz: vec2f) -> vec4f {
  // The seed walks the tileable weather map so each variation shows a different patch of sky.
  let seedOffset = vec2f(0.31 + fract(c.seed * 0.173), 0.62 + fract(c.seed * 0.377));
  return textureSampleLevel(weather, weatherSampler, xz / c.weatherScale + seedOffset + vec2f(c.wind * 0.004, c.wind * 0.001), 0.0);
}

/** Cumulus grows tall, stratus stays flat; both vanish at the layer bounds. */
fn heightGradient(hf: f32, cloudType: f32) -> f32 {
  // A long taper raises the iso-surface threshold with height, so the 3D noise decides where each column's
  // top sits (cauliflower); the density sharpening after thresholding keeps that surface opaque.
  let stratus = smoothstep(0.0, 0.08, hf) * (1.0 - smoothstep(0.2, 0.42, hf));
  let cumulus = smoothstep(0.0, 0.1, hf) * (1.0 - smoothstep(0.45, 1.0, hf));
  return mix(stratus, cumulus, cloudType);
}

/**
 * Cloud density in [0, density]. `position` is planet-centric; xz doubles as the tangent-plane coordinate.
 * `cheap` skips the erosion detail (used by light marches). `viewDistance` from the camera drives the detail
 * LOD: erosion, the second detail scale and the curl distortion fade out past `detailLodDistance`.
 */
export fn cloudDensity(
  c: Clouds, shape: texture_3d<f32>, detail: texture_3d<f32>, weather: texture_2d<f32>, curl: texture_2d<f32>, noiseSampler: sampler,
  position: vec3f, altitude: f32, viewDistance: f32, cheap: bool,
) -> f32 {
  let rawHf = heightFraction(c, altitude);
  if (rawHf <= 0.0 || rawHf >= 1.0) { return 0.0; }
  let w = sampleWeather(weather, noiseSampler, c, position.xz);
  let coverage = saturate(remap(w.r, 0.3, 0.75, 0.0, 1.0) * c.coverage * 1.2);
  if (coverage <= 0.0) { return 0.0; }
  // The constant offset just picks a pleasant patch of the tiled noise around the origin.
  let unwarped = vec3f(position.x, altitude, position.z) + vec3f(53.0 + c.wind * 0.02, 0.0, 29.0);
  // Gentle low-frequency domain warp hides the lattice of the tiled noise; keep the amplitude well
  // below the warp texel size or the piecewise-linear filtering tears the shape into creases.
  let warp = textureSampleLevel(shape, noiseSampler, unwarped / (c.shapeScale * 2.7) + vec3f(0.5, 0.2, 0.8), 0.0).gba - 0.5;
  let p = unwarped + warp * c.shapeScale * 0.22;
  let s = textureSampleLevel(shape, noiseSampler, p / c.shapeScale, 0.0);
  // Top relief: the low-frequency Worley cells (2.4 km and 1.2 km) decide how high each column reaches, so
  // the deck breaks into towers and valleys that shadow each other instead of one smooth dome.
  let relief = mix(0.7, 1.1, s.r * 0.5 + s.g * 0.3 + s.b * 0.2);
  let hf = rawHf / (mix(0.7, 1.0, w.b) * relief);
  if (hf >= 1.0) { return 0.0; }
  let gradient = heightGradient(hf, saturate(w.g + c.typeBias));
  if (gradient <= 0.0) { return 0.0; }
  let lowFbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  var base = saturate(remap(s.r, lowFbm - 1.0, 1.0, 0.0, 1.0)) * gradient;
  base = saturate(remap(base, 1.0 - coverage, 1.0, 0.0, 1.0));
  // A small floor keeps the air between clouds clear instead of a faint fog.
  base = saturate((base - 0.06) / 0.94);
  if (base <= 0.0) { return 0.0; }
  // Interior Worley structure so the optical depth varies (a wide range, or the sun sees every column as the same
  // slab and the bases come out flat), and a sharpening that makes the surface opaque within metres like a real
  // water cloud. The erosion below runs on the soft base first: it needs the wide edge band.
  let interior = mix(0.35, 1.0, lowFbm) * c.density;
  if (cheap) { return saturate(base * 2.2) * interior; }
  // Erosion only matters near the surface of the cloud. Three LOD rings by feature size: the coarse detail
  // (hundreds of metres) survives to 4x detailLodDistance, the curl to 2x, the fine scale (tens of metres) to 1x.
  // Past a ring the pattern is dropped but not the density it removes: the erosion continues at its mean, so a
  // cloud keeps the same amount of matter at any distance and only loses features that are sub-pixel anyway.
  let edge = 1.0 - smoothstep(0.3, 0.6, base);
  let strength = edge * c.detailStrength;
  if (strength <= 0.0) { return saturate(base * 2.2) * interior; }
  let coarseLod = 1.0 - smoothstep(c.detailLodDistance * 3.0, c.detailLodDistance * 4.0, viewDistance);
  var detailFbm = DETAIL_FBM_MEAN;
  if (coarseLod > 0.0) {
    let curlLod = 1.0 - smoothstep(c.detailLodDistance * 1.5, c.detailLodDistance * 2.0, viewDistance);
    let fineLod = 1.0 - smoothstep(c.detailLodDistance * 0.6, c.detailLodDistance, viewDistance);
    var distorted = p;
    if (curlLod > 0.0) {
      // Curl distortion of the lookup makes the edges wispy; it grows toward the cloud top.
      let flow = textureSampleLevel(curl, noiseSampler, p.xz / (c.detailScale * 5.0), 0.0).rg * 2.0 - 1.0;
      distorted = p + vec3f(flow.x, 0.0, flow.y) * c.curlStrength * curlLod * (0.3 + 0.7 * hf);
    }
    let coarse = textureSampleLevel(detail, noiseSampler, distorted / c.detailScale, 0.0).rgb;
    var sampled = coarse.r * 0.625 + coarse.g * 0.25 + coarse.b * 0.125;
    if (fineLod > 0.0) {
      let fine = textureSampleLevel(detail, noiseSampler, distorted / (c.detailScale * 0.27) + vec3f(0.5), 0.0).rgb;
      sampled = mix(sampled, fine.r * 0.625 + fine.g * 0.25 + fine.b * 0.125, 0.3 * fineLod);
    }
    detailFbm = mix(DETAIL_FBM_MEAN, sampled, coarseLod);
  }
  let modifier = mix(detailFbm, 1.0 - detailFbm, saturate(hf * 8.0)) * 0.45 * strength;
  let eroded = saturate(remap(base, modifier, 1.0, 0.0, 1.0));
  return saturate(eroded * 2.2) * interior;
}

/** Both intersections with a sphere at the origin: (near, far), or (-1, -1) when missed. */
fn raySphereBoth(origin: vec3f, dir: vec3f, radius: f32) -> vec2f {
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let delta = b * b - 4.0 * c;
  if (delta < 0.0) { return vec2f(-1.0); }
  let root = sqrt(delta);
  return vec2f((-b - root) * 0.5, (-b + root) * 0.5);
}

export struct MarchRange { start: f32, end: f32, valid: bool };

/** Entry/exit of the cloud shell along a ray, for a camera below, inside or above it. */
export fn cloudRange(c: Clouds, origin: vec3f, dir: vec3f, viewHeight: f32) -> MarchRange {
  let rBottom = c.groundRadius + c.bottom;
  let rTop = c.groundRadius + c.top;
  let bottom = raySphereBoth(origin, dir, rBottom);
  let top = raySphereBoth(origin, dir, rTop);
  if (viewHeight < rBottom) {
    // Below the layer: the far bottom intersection is the entry, the far top intersection is the exit.
    return MarchRange(max(bottom.y, 0.0), top.y, top.y > 0.0);
  }
  if (viewHeight > rTop) {
    // Above the layer: enter at the near top intersection, exit at the near bottom one (or the far top one).
    if (top.x < 0.0) { return MarchRange(0.0, 0.0, false); }
    let exit = select(top.y, bottom.x, bottom.x > 0.0);
    return MarchRange(top.x, exit, true);
  }
  // Inside the layer.
  let exit = select(top.y, bottom.x, bottom.x > 0.0);
  return MarchRange(0.0, exit, true);
}

/** Sun transmittance of the cloud layer along the light through a point (relative to the ground point under the camera); 1 when cloud shadows are off. */
export fn sampleCloudShadow(c: Clouds, shadow: SunShadow, map: texture_2d<f32>, mapSampler: sampler, fromGround: vec3f) -> f32 {
  if (c.shadows < 0.5) { return 1.0; }
  let s = shadow.toShadow2 * vec4f(fromGround, 1.0);
  if (any(abs(s.xy) > vec2f(1.0))) { return 1.0; }
  return textureSampleLevel(map, mapSampler, vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5), 0.0).r;
}

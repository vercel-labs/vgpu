import { AERIAL_KM_PER_SLICE, AERIAL_LUT_DEPTH, AERIAL_MAX_DISTANCE, Atmosphere, Camera, FrameConstants, PI, PLANET_RADIUS_OFFSET, cameraRay, raySphere, sampleTransmittance } from "./atmosphere-common.wgsl";
import { Clouds, cloudDensity, cloudRange, heightFraction } from "./clouds-common.wgsl";
import { CloudUpdate, compactToTexel } from "./clouds-temporal.wgsl";

@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> clouds: Clouds;
@group(0) @binding(3) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(4) var aerialLut: texture_3d<f32>;
@group(0) @binding(5) var shapeNoise: texture_3d<f32>;
@group(0) @binding(6) var detailNoise: texture_3d<f32>;
@group(0) @binding(7) var weatherMap: texture_2d<f32>;
@group(0) @binding(8) var sceneHdr: texture_2d<f32>;
@group(0) @binding(9) var lutSampler: sampler;
@group(0) @binding(10) var noiseSampler: sampler;
@group(0) @binding(11) var<uniform> update: CloudUpdate;
@group(0) @binding(12) var curlNoise: texture_2d<f32>;
@group(0) @binding(13) var<storage, read> frame: FrameConstants;

// Marches this frame's live cloud texels, packed into the compact target (clouds-temporal.wgsl); the pass is drawn
// with a viewport of the compact size and clouds-resolve.wgsl scatters the results into the history.

/** Step budget from horizon to zenith rays in the fast mode; at rest (`detail` = 1) it doubles. */
const MARCH_STEPS: f32 = 160.0;
const MIN_MARCH_STEPS: f32 = 80.0;
const MAX_MARCH_STEPS: i32 = 320;
/** Densities below this are treated as the cloud surface and marched with half steps. */
const EDGE_DENSITY: f32 = 0.12;
const LIGHT_STEPS: i32 = 6;
const MAX_MARCH_DISTANCE: f32 = 70.0;
/** Extinction per unit density, 1/km (cumulus, ~0.03/m). */
const EXTINCTION: f32 = 32.0;
const ALBEDO: f32 = 0.97;
const FORWARD_G: f32 = 0.75;
const BACK_G: f32 = -0.3;
/**
 * Multiple-scattering octaves (Wrenninge): per-octave scattering, extinction and phase-eccentricity multipliers.
 * Scattering 0.5 rather than 0.7: at optical depth 10 the octaves passed 40 % of the light, which lit thick cloud
 * bases as brightly as their rims; at 0.5 they pass 12 %, and the bases darken with the column above them.
 */
const MS_OCTAVES: i32 = 6;
const MS_SCATTER: f32 = 0.5;
const MS_EXTINCTION: f32 = 0.5;
const MS_PHASE: f32 = 0.5;

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

fn dualLobePhase(cosTheta: f32, octave: f32) -> f32 {
  return mix(henyeyGreenstein(cosTheta, FORWARD_G * octave), henyeyGreenstein(cosTheta, BACK_G * octave), 0.3);
}

/** pcg2d (Jarzynski & Olano 2020): a real integer hash, unlike the row-wise ramp it replaces. */
fn pcg2d(v: vec2u) -> vec2u {
  var p = v * 1664525u + 1013904223u;
  p.x += p.y * 1664525u;
  p.y += p.x * 1664525u;
  p ^= p >> vec2u(16u);
  p.x += p.y * 1664525u;
  p.y += p.x * 1664525u;
  p ^= p >> vec2u(16u);
  return p;
}

/**
 * March offset per history texel and frame: white noise across texels, so the step quantisation of the march becomes
 * grain instead of bands, stepped by the golden ratio over frames, so each texel's successive refreshes sample the
 * step evenly and the accumulation converges in a few refreshes. (Interleaved gradient noise was tried first: its
 * diagonal structure stayed visible as a drifting weave.)
 */
fn marchNoise(texel: vec2i, frameIndex: i32) -> f32 {
  let spatial = f32(pcg2d(vec2u(texel)).x) / 4294967295.0;
  return fract(spatial + 0.6180339887 * f32(frameIndex % 64));
}

fn density(position: vec3f, viewDistance: f32, cheap: bool) -> f32 {
  let altitude = length(position) - atmosphere.groundRadius;
  return cloudDensity(clouds, shapeNoise, detailNoise, weatherMap, curlNoise, noiseSampler, position, altitude, viewDistance, cheap);
}

/**
 * Optical depth toward the sun with doubling steps (20 m to 640 m). The three nearest samples use the full,
 * eroded density so the surface bumps shadow their own crevices; the far ones skip erosion and are scaled down.
 * Only the near samples are jittered within their step: they are what terraces the lit faces, and jittering the
 * far ones (160 to 640 m) moved them through whole clouds and turned the lighting into speckle.
 */
fn lightOpticalDepth(position: vec3f, sunDir: vec3f, viewDistance: f32, noise: f32) -> f32 {
  var depth = 0.0;
  var t = 0.0;
  var step = 0.02;
  for (var i = 0; i < LIGHT_STEPS; i += 1) {
    let near = i < 3;
    let sample = t + step * select(0.5, mix(0.25, 0.75, noise), near);
    depth += density(position + sunDir * sample, viewDistance, !near) * step * select(0.75, 1.0, near);
    t += step;
    step *= 2.0;
  }
  return depth * EXTINCTION;
}

/** Per-octave phase times scattering weight. Depends only on the ray/sun angle, so it is built once per pixel. */
fn octavePhases(cosTheta: f32) -> array<f32, MS_OCTAVES> {
  var phases: array<f32, MS_OCTAVES>;
  var scatter = 1.0;
  var phaseScale = 1.0;
  for (var i = 0; i < MS_OCTAVES; i += 1) {
    phases[i] = scatter * dualLobePhase(cosTheta, phaseScale);
    scatter *= MS_SCATTER;
    phaseScale *= MS_PHASE;
  }
  return phases;
}

/**
 * Sum of attenuated scattering octaves; higher octaves see less extinction and a flatter phase.
 * With MS_EXTINCTION = 0.5 the octave attenuations are exp(-od / 2^k): one exp for the last octave, then squaring.
 */
fn multiScatter(opticalDepth: f32, phases: array<f32, MS_OCTAVES>) -> f32 {
  var sum = 0.0;
  var attenuation = exp(-opticalDepth * pow(MS_EXTINCTION, f32(MS_OCTAVES - 1)));
  for (var i = MS_OCTAVES - 1; i >= 0; i -= 1) {
    sum += phases[i] * attenuation;
    attenuation *= attenuation;
  }
  return sum;
}

fn sampleAerial(uv: vec2f, distance: f32) -> vec4f {
  var slice = distance / AERIAL_KM_PER_SLICE;
  var weight = 1.0;
  if (slice < 0.5) { weight = saturate(slice * 2.0); slice = 0.5; }
  let w = sqrt(slice / AERIAL_LUT_DEPTH);
  return weight * textureSampleLevel(aerialLut, lutSampler, vec3f(uv, w), 0.0);
}

/** Premultiplied luminance with transmittance in alpha, for the history texel this compact texel stands for. */
@fragment fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let p = atmosphere;
  let period = i32(update.refreshPeriod);
  let frameIndex = i32(update.frame);
  let texel = compactToTexel(vec2i(fragCoord.xy), frameIndex, period);
  let uv = (vec2f(texel) + 0.5) / update.size;
  // Sub-texel jitter only matters when the result is blended into the history; it is zero otherwise.
  let jitteredUv = uv + update.jitter / update.size;
  let dir = cameraRay(camera, vec2f(jitteredUv.x * 2.0 - 1.0, 1.0 - jitteredUv.y * 2.0));
  // The noise only animates while the accumulation can average it; with full blend (a still, or the frames right
  // after a change) a static pattern keeps the fresh texels consistent with their neighbours instead of shimmering.
  let noiseFrame = select(0, frameIndex, update.blend < 1.0);
  return marchClouds(p, dir, marchNoise(texel, noiseFrame), uv);
}

fn marchClouds(p: Atmosphere, dir: vec3f, noise: f32, uv: vec2f) -> vec4f {
  let origin = camera.position;
  let viewHeight = length(origin);
  var range = cloudRange(clouds, origin, dir, viewHeight);
  // The scene pixel under this texel's centre, the same one present.wgsl compares against when it upsamples:
  // a filtered read would blend sky (-1) with terrain distances at silhouettes.
  let sceneSize = vec2i(textureDimensions(sceneHdr));
  let sceneDistance = textureLoad(sceneHdr, clamp(vec2i(uv * vec2f(sceneSize)), vec2i(0), sceneSize - 1), 0).a;
  if (sceneDistance > 0.0) { range.end = min(range.end, sceneDistance); }
  range.end = min(range.end, range.start + MAX_MARCH_DISTANCE);
  let empty = vec4f(0.0, 0.0, 0.0, 1.0);
  if (!range.valid || range.end <= range.start || clouds.coverage <= 0.0) { return empty; }

  let cosTheta = dot(dir, p.sunDirection);
  let phases = octavePhases(cosTheta);
  let skyAmbient = frame.skyAmbient;
  let groundBounce = frame.groundBounce;

  // Rays near the horizon cross far more cloud than rays near the zenith, so the step budget follows the elevation;
  // at rest it doubles, which halves the step and with it the grain the accumulation has to average.
  let stepBudget = mix(MARCH_STEPS, MIN_MARCH_STEPS, abs(dir.y)) * mix(1.0, 2.0, update.detail);
  let fineStep = max(0.02, (range.end - range.start) / stepBudget);
  let coarseStep = fineStep * 2.0;
  var t = range.start + fineStep * noise;
  var transmittance = 1.0;
  var luminance = vec3f(0.0);
  var depthSum = 0.0;
  var emptySamples = 0;
  var coarse = false;
  for (var i = 0; i < MAX_MARCH_STEPS; i += 1) {
    if (t >= range.end || transmittance < 0.01 || f32(i) >= stepBudget) { break; }
    let position = origin + dir * t;
    let sampleDensity = density(position, t, false);
    if (sampleDensity <= 0.0) {
      emptySamples += 1;
      // After a few empty fine samples switch to coarse stepping; the pull-back below restores precision.
      coarse = emptySamples > 3;
      t += select(fineStep, coarseStep, coarse);
      continue;
    }
    if (coarse) {
      // Coarse step hit density: back up one coarse step and resample finely.
      coarse = false;
      emptySamples = 0;
      t -= coarseStep - fineStep;
      continue;
    }
    emptySamples = 0;
    // Thin samples are the cloud's visible surface: halve the step there so the eroded detail resolves.
    let step = select(fineStep, fineStep * 0.5, sampleDensity < EDGE_DENSITY);
    let altitude = length(position) - p.groundRadius;
    let hf = heightFraction(clouds, altitude);
    let up = position / length(position);
    let sunZenithCos = dot(up, p.sunDirection);
    // Planet shadow: after sunset only clouds whose own horizon still shows the sun stay lit. The ray test is
    // skipped while the sun is high enough that no sample within reach can be shadowed.
    let earthShadow = select(1.0, 0.0, p.sunDirection.y < 0.06 && raySphere(position + up * PLANET_RADIUS_OFFSET, p.sunDirection, p.groundRadius) >= 0.0);
    let sunTransmittance = sampleTransmittance(p, transmittanceLut, lutSampler, p.groundRadius + altitude, sunZenithCos) * earthShadow;
    let opticalDepth = lightOpticalDepth(position, p.sunDirection, t, noise);
    let sunScatter = multiScatter(opticalDepth, phases);
    // The sky lights a sample through the cloud above it. While the sun is high its optical depth is a fair stand-in
    // for the depth toward the zenith, so the sky ambient fades into the cloud bases instead of filling them flat;
    // near the horizon the stand-in is wrong and the term fades out. The ground bounce stays small for the same
    // reason: a uniform fill from below is what made every base one shade of grey.
    let skyOcclusion = exp(-opticalDepth * 0.3 * saturate(p.sunDirection.y * 1.5));
    let ambient = skyAmbient * mix(0.12, 0.75, hf) * skyOcclusion + groundBounce * (1.0 - hf) * 0.1;
    let extinction = EXTINCTION * sampleDensity;
    let scattered = ALBEDO * extinction * (p.sunIlluminance * sunTransmittance * sunScatter + ambient);
    let stepTransmittance = exp(-extinction * step);
    let integrated = (scattered - scattered * stepTransmittance) / extinction;
    luminance += transmittance * integrated;
    depthSum += t * transmittance * (1.0 - stepTransmittance);
    transmittance *= stepTransmittance;
    t += step;
  }

  let opacity = 1.0 - transmittance;
  if (opacity <= 0.0) { return empty; }
  // Aerial perspective at the transmittance-weighted mean depth, applied to the cloud's own contribution.
  let meanDepth = depthSum / opacity;
  let aerial = sampleAerial(uv, min(meanDepth, AERIAL_MAX_DISTANCE));
  let color = luminance * (1.0 - aerial.a) + aerial.rgb * opacity;
  return vec4f(color, transmittance);
}

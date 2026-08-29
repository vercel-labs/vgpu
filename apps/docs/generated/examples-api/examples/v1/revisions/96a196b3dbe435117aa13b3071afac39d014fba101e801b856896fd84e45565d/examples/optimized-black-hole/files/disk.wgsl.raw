// Accretion-disk material with deterministic tiled noise and radial prefiltering.

import { GBufferSample, HORIZON, ISCO } from "./gbuffer.wgsl";

export struct DiskLook {
  brightness: f32,
  speed: f32,
  stretch: f32,
  detail: f32,
  turbulence: f32,
  density: f32,
  doppler: f32,
  cloudScale: f32,
  cloudSpeed: f32,
  cloudStrength: f32,
  spare0: f32,
  spare1: f32,
  spare2: f32,
  spare3: f32,
}

export struct DiskSample {
  color: vec3f,
  alpha: f32,
}

struct NoiseLattice {
  invSize: f32,
}

fn noise3(tex: texture_3d<f32>, samp: sampler, lattice: NoiseLattice, p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return textureSampleLevel(tex, samp, (i + u + vec3f(0.5)) * lattice.invSize, 0.0).r;
}

fn streakFbm(
  tex: texture_3d<f32>,
  samp: sampler,
  lattice: NoiseLattice,
  angle: f32,
  radius: f32,
  angScale: f32,
  radScale: f32,
  octaves: i32,
  dAngle: f32,
  dRadius: f32,
  lacAng: f32,
  lacRad: f32,
  seed: f32,
) -> f32 {
  var value: f32 = 0.0;
  var total: f32 = 0.0;
  var amplitude: f32 = 0.5;
  var a = angScale;
  var r = radScale;
  var offset = seed;
  for (var i = 0; i < octaves; i++) {
    let visible = clamp(1.0 - 1.7 * max(dAngle * a, dRadius * r), 0.0, 1.0);
    var sampleValue: f32 = 0.5;
    if (visible > 0.004) {
      sampleValue = mix(
        0.5,
        noise3(tex, samp, lattice, vec3f(cos(angle) * a, sin(angle) * a, radius * r + offset)),
        visible,
      );
    }
    value += amplitude * sampleValue;
    total += amplitude;
    a *= lacAng;
    r *= lacRad;
    offset += 23.7;
    amplitude *= 0.55;
  }
  return value / max(total, 0.0001);
}

fn ridgeFbm(
  tex: texture_3d<f32>,
  samp: sampler,
  lattice: NoiseLattice,
  angle: f32,
  radius: f32,
  angScale: f32,
  radScale: f32,
  octaves: i32,
  dAngle: f32,
  dRadius: f32,
  lacAng: f32,
  lacRad: f32,
  seed: f32,
) -> f32 {
  var value: f32 = 0.0;
  var total: f32 = 0.0;
  var amplitude: f32 = 0.5;
  var a = angScale;
  var r = radScale;
  var offset = seed;
  for (var i = 0; i < octaves; i++) {
    let visible = clamp(1.0 - 1.7 * max(dAngle * a, dRadius * r), 0.0, 1.0);
    var crest: f32 = 0.42;
    if (visible > 0.004) {
      let n = noise3(tex, samp, lattice, vec3f(cos(angle) * a, sin(angle) * a, radius * r + offset));
      crest = mix(0.42, pow(1.0 - abs(n * 2.0 - 1.0), 1.35), visible);
    }
    value += amplitude * crest;
    total += amplitude;
    a *= lacAng;
    r *= lacRad;
    offset += 41.9;
    amplitude *= 0.62;
  }
  return value / max(total, 0.0001);
}

struct FieldParams {
  angBase: f32,
  radBase: f32,
  flowRad: f32,
  chaos: f32,
  outward: f32,
  dAngle: f32,
  dRadius: f32,
}

fn smokeField(
  tex: texture_3d<f32>, samp: sampler, lattice: NoiseLattice,
  angle: f32, radius: f32, p: FieldParams,
) -> vec2f {
  let warpA = (streakFbm(
    tex, samp, lattice, angle, radius, p.angBase * 0.55, p.flowRad * 1.6,
    2, p.dAngle, p.dRadius, 1.6, 2.0, 3.7,
  )) - 0.5;
  let warpB = (streakFbm(
    tex, samp, lattice, angle + 2.4, radius * 1.13,
    p.angBase * 2.8, p.radBase * 0.45, 3, p.dAngle, p.dRadius,
    1.7, 2.0, 61.3,
  )) - 0.5;
  let radiusW = radius + (warpA * 1.9 + warpB * 1.25 * p.outward) * p.chaos;
  let angleW = angle + (warpB * 0.9 - warpA * 0.35) * p.chaos * 0.55 / max(radius * 0.22, 0.35);

  let flow = streakFbm(
    tex, samp, lattice, angleW, radiusW, p.angBase, p.flowRad,
    3, p.dAngle, p.dRadius, 2.0, 1.12, 131.7,
  );
  let threads = ridgeFbm(
    tex, samp, lattice, angleW, radiusW, p.angBase * 0.85, p.radBase,
    5, p.dAngle, p.dRadius, 1.26, 2.05, 0.0,
  );

  let fineVis = clamp(1.0 - 1.7 * max(p.dAngle * p.angBase * 0.85, p.dRadius * p.radBase), 0.0, 1.0);
  let field = mix(flow, flow * 0.22 + threads * 1.05, fineVis);
  let rim = (warpA + warpB * 0.5) * 0.9;
  return vec2f(f32(field), rim);
}

const FIELD_MEAN = 0.52;

const SHEAR_REF_RADIUS = 6.5;

export const SHEAR_PERIOD: f32 = 10.0;
const TWO_PI = 6.283185307;

export fn shadeDisk(
  g: GBufferSample,
  look: DiskLook,
  time: f32,
  footprint: f32,
  noiseTex: texture_3d<f32>,
  noiseSampler: sampler,
) -> DiskSample {
  var lattice: NoiseLattice;
  lattice.invSize = 1.0 / f32(textureDimensions(noiseTex).x);

  let plane = vec2f(g.position.x, g.position.z);
  let radius = g.diskPolar.x;
  let azimuth = g.diskPolar.y;
  let radiusNorm = clamp(g.diskUv.x, 0.0, 1.0);
  let viewDirection = g.viewDirection;

  let slant = max(abs(viewDirection.y), 0.022);
  let grazing = min(1.0 / slant, 34.0);

  let viewPlane = normalize(vec2f(viewDirection.x, viewDirection.z) + vec2f(1e-6, 0.0));
  let radialDir = normalize(plane + vec2f(1e-6, 0.0));
  let alignR = clamp(abs(dot(radialDir, viewPlane)), 0.0, 1.0);
  let alignT = sqrt(max(1.0 - alignR * alignR, 0.0));
  let stretchSq = grazing * grazing - 1.0;
  let kR = sqrt(1.0 + stretchSq * alignR * alignR);   // radial elongation
  let kT = sqrt(1.0 + stretchSq * alignT * alignT);   // tangential elongation
  let baseScaleR = max(look.detail, 0.05);
  let baseScaleA = max(look.stretch, 0.05);
  let pixelWorld = footprint / max(baseScaleR * kR, baseScaleA * kT / max(radius, ISCO));
  let dRadius = pixelWorld * kR;
  let dAngle = pixelWorld * kT / max(radius, ISCO);

  let omega = look.speed * 0.55 / pow(radius, 1.5);
  let omegaRef = look.speed * 0.55 / pow(SHEAR_REF_RADIUS, 1.5);
  let dOmega = omega - omegaRef;
  let rigid = fract(time * omegaRef / TWO_PI) * TWO_PI;
  let swirl = max(0.0, 0.85 + look.spare1);
  let flowBase = azimuth - rigid + swirl * log(radius / ISCO);

  let cycle = time / SHEAR_PERIOD;
  let u0 = fract(cycle);
  let u1 = fract(cycle + 0.5);
  let shear0 = (u0 - 0.5) * SHEAR_PERIOD;
  let shear1 = (u1 - 0.5) * SHEAR_PERIOD;
  let w0 = 1.0 - abs(2.0 * u0 - 1.0);
  let w1 = 1.0 - w0;
  let angle0 = flowBase - dOmega * shear0;
  let angle1 = flowBase - dOmega * shear1;

  let outward = smoothstep(0.0, 0.92, radiusNorm);
  let fray = max(0.0, 1.0 + look.spare3);
  let chaos = look.turbulence * (0.08 + 2.10 * outward * outward) * fray;

  let angBase = max(look.stretch, 0.05) * 0.45 * (0.80 + 1.45 * outward * fray);
  let radBase = max(look.detail, 0.05) * 2.35;
  let flowRad = max(look.detail, 0.05) * 0.105;

  var params: FieldParams;
  params.angBase = angBase;
  params.radBase = radBase;
  params.flowRad = flowRad;
  params.chaos = chaos;
  params.outward = outward;
  params.dAngle = dAngle;
  params.dRadius = dRadius;
  let lobeShift = abs(dOmega) * SHEAR_PERIOD * 0.5 * angBase * 0.85;
  let rho = 1.0 - smoothstep(0.12, 1.1, lobeShift);

  var blended: vec2f;
  var lobeVariance = 1.0;
  if (rho > 0.98) {
    let angleMerged = mix(angle1, angle0, w0);
    blended = smokeField(noiseTex, noiseSampler, lattice, angleMerged, radius, params);
  } else {
    let lobe0 = smokeField(noiseTex, noiseSampler, lattice, angle0, radius, params);
    let lobe1 = smokeField(noiseTex, noiseSampler, lattice, angle1, radius, params);
    blended = mix(lobe1, lobe0, w0);
    lobeVariance = sqrt(max(w0 * w0 + w1 * w1 + 2.0 * rho * w0 * w1, 0.25));
  }
  var field = FIELD_MEAN + (blended.x - FIELD_MEAN) / lobeVariance;

  let cloudRate = omegaRef * look.cloudSpeed;
  let cloudRigid = fract(time * cloudRate / TWO_PI) * TWO_PI;
  let cloudAngle = azimuth - cloudRigid + 0.32 * log(radius / ISCO);
  let cloudScale = max(look.cloudScale, 0.05);
  let cloudRaw = streakFbm(
    noiseTex,
    noiseSampler,
    lattice,
    cloudAngle,
    radius,
    cloudScale,
    cloudScale * 0.34,
    2,
    dAngle,
    dRadius,
    1.72,
    1.86,
    211.7,
  );
  let cloud = smoothstep(0.28, 0.72, cloudRaw);
  let cloudStrength = clamp(look.cloudStrength, 0.0, 0.95);
  let cloudMultiplier = mix(1.0 - cloudStrength, 1.0 + cloudStrength, cloud);
  field *= cloudMultiplier;

  let rimNoise = blended.y;
  let innerEdge = smoothstep(0.0, 0.055, radiusNorm);
  let outerEdge = 1.0 - smoothstep(0.42 + rimNoise * 0.30 * fray, 1.0, radiusNorm);
  let envelope = innerEdge * outerEdge * mix(1.0, 0.62, outward);

  let contrast = max(0.2, 1.0 + look.spare2);
  let lo = 0.50 - 0.16 / contrast;
  let hi = 0.50 + 0.21 / contrast;
  var smoke = clamp(pow(smoothstep(lo, hi, field), 1.0 + 0.9 * contrast) * envelope, 0.0, 1.0);

  let fieldN = clamp((field - (lo - 0.10)) / max(hi - lo + 0.26, 0.02), 0.0, 1.0);
  let emissivity = (mix(0.05, 1.0, pow(fieldN, 1.35)) + 2.2 * pow(fieldN, 5.0)) * envelope;

  let path = pow(grazing, 0.62);
  let thickness = mix(0.30, 0.85, radiusNorm);
  let opticalDepth = smoke * thickness * path * look.density * 0.95;
  let coverage = 1.0 - exp(-opticalDepth);

  let heat = pow(1.0 - radiusNorm, 1.25);
  var thermal = mix(vec3f(0.52, 0.14, 0.03), vec3f(1.0, 0.56, 0.17), smoothstep(0.03, 0.5, heat));
  thermal = mix(thermal, vec3f(1.0, 0.94, 0.83), pow(heat, 2.2));

  let tangent = normalize(vec3f(-plane.y, 0.0, plane.x));
  let orbitalSpeed = min(0.64, 0.94 / sqrt(max(radius - HORIZON, 0.25)));
  let towardObserver = dot(tangent, -normalize(viewDirection));
  let beaming = pow(clamp(1.0 / (1.0 - orbitalSpeed * towardObserver), 0.72, 1.55), 1.5 * look.doppler);
  let redshift = sqrt(max(1.0 - HORIZON / radius, 0.025));

  let facing = mix(0.82, 1.0, step(0.0, g.side));

  let flux = pow(clamp(ISCO / radius, 0.0, 1.0), 1.7);
  let core = 1.0 + 2.6 * pow(1.0 - radiusNorm, 5.0);

  let arcLift = max(0.0, 1.0 + look.spare0);
  let faceOn = smoothstep(0.16, 0.75, abs(viewDirection.y));
  let lift = 1.0 + 1.55 * arcLift * faceOn;
  let edgeGlow = 1.0 + 0.55 * smoothstep(6.0, 26.0, grazing);

  let source = thermal * beaming * redshift * facing * flux * lift * edgeGlow * core * emissivity;
  let emission = source * look.brightness * 1.35;

  var sample: DiskSample;
  sample.color = vec3f(emission);
  sample.alpha = coverage;
  return sample;
}

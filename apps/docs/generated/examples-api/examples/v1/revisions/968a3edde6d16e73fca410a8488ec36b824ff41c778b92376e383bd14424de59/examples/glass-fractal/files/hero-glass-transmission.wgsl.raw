import { presentCeramic } from "./hero-fractal-ceramic.wgsl";
import {
  rotateHeroEnvironmentDirection,
  sampleHeroEnvironment,
} from "./hero-glass-environment.wgsl";

// The planar regions of the rounded mesh lie exactly on these four planes.
// Beveled pixels begin slightly inside the same convex hull, so intersecting
// the hull remains a stable approximation at corners without a depth march.
const V0 = vec3f(0.0, 1.0, 0.0);
const V1 = vec3f(0.94280904158, -0.33333333333, 0.0);
const V2 = vec3f(-0.47140452079, -0.33333333333, 0.81649658093);
const V3 = vec3f(-0.47140452079, -0.33333333333, -0.81649658093);
const TETRAHEDRON_PLANE = 0.33333333333;

struct GlassParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  meshMin: vec3f,
  meshMax: vec3f,
  resolution: vec2f,
  fractalScale: f32,
  ior: f32,
  reflectionStrength: f32,
  backOpacity: f32,
  absorption: vec3f,
  frostRadius: f32,
  dispersion: f32,
  iridescenceStrength: f32,
  iridescenceFrequency: f32,
  environmentRotation: mat4x4f,
  environmentExposure: f32,
  reflectionDebug: f32,
}
@group(0) @binding(0) var<uniform> params: GlassParams;
@group(0) @binding(1) var environmentTexture: texture_2d_array<f32>;
@group(0) @binding(2) var environmentSampler: sampler;
@group(0) @binding(3) var sceneTexture: texture_2d<f32>;
@group(0) @binding(4) var sceneSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
) -> VertexOut {
  let localPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  let world = params.model * vec4f(localPosition, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(packed_normal.xyz, 0.0)).xyz);
  return out;
}

fn environment(direction: vec3f) -> vec3f {
  return sampleHeroEnvironment(
    environmentTexture,
    environmentSampler,
    rotateHeroEnvironmentDirection(direction, params.environmentRotation),
  ) * params.environmentExposure;
}

fn presentReflectionDebug(color: vec3f) -> vec4f {
  return vec4f(
    pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)),
    1.0,
  );
}

fn dielectricFresnel(ior: f32, facing: f32) -> f32 {
  let ratio = (ior - 1.0) / (ior + 1.0);
  let f0 = ratio * ratio;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(facing, 0.0, 1.0), 5.0);
}

fn planeExitDistance(
  origin: vec3f,
  direction: vec3f,
  outward: vec3f,
) -> f32 {
  let denominator = dot(outward, direction);
  if (denominator <= 0.00001) { return 100000.0; }
  let distance = (
    TETRAHEDRON_PLANE - dot(outward, origin)
  ) / denominator;
  return select(100000.0, distance, distance > 0.0001);
}

fn tetrahedronExitDistance(origin: vec3f, direction: vec3f) -> f32 {
  return min(
    min(
      planeExitDistance(origin, direction, -V0),
      planeExitDistance(origin, direction, -V1),
    ),
    min(
      planeExitDistance(origin, direction, -V2),
      planeExitDistance(origin, direction, -V3),
    ),
  );
}

fn projectToUv(point: vec3f) -> vec2f {
  let clip = params.viewProjection * vec4f(point, 1.0);
  let ndc = clip.xy / max(clip.w, 0.00001);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn sampleInterior(uv: vec2f, halfTexel: vec2f) -> vec3f {
  let safeUv = clamp(uv, halfTexel, vec2f(1.0) - halfTexel);
  return textureSampleLevel(sceneTexture, sceneSampler, safeUv, 0.0).rgb;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.worldNormal);
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflectedDirection = reflect(incident, normal);
  let reflectedEnvironment = environment(reflectedDirection);
  if (params.reflectionDebug > 0.5) {
    return presentReflectionDebug(reflectedEnvironment);
  }
  let fresnel = dielectricFresnel(params.ior, facing);
  let refracted = normalize(refract(incident, normal, 1.0 / params.ior));
  let exitDistance = tetrahedronExitDistance(
    in.worldPosition + refracted * 0.0002,
    refracted,
  );

  let originalUv = in.position.xy / max(params.resolution, vec2f(1.0));
  let validExit = exitDistance < 10.0;
  // The first pass contains a normally projected raster mesh rather than a
  // volume we can trace. Sample at the nested tetrahedron's front surface: it
  // preserves the mesh silhouette while the IOR still bends its screen-space
  // lookup by the physical shell gap.
  let shellGap = (1.0 - params.fractalScale) * TETRAHEDRON_PLANE;
  let insetDistance = shellGap / max(-dot(normal, refracted), 0.05);
  let sampleDistance = min(exitDistance, insetDistance);
  let samplePoint = in.worldPosition + refracted * select(0.0, sampleDistance, validExit);
  let refractedUv = select(originalUv, projectToUv(samplePoint), validExit);
  let safeResolution = max(params.resolution, vec2f(1.0));
  let halfTexel = 0.5 / safeResolution;

  // Four stable bilinear taps provide a subtle frosted transmission without a
  // noise texture, temporal shimmer, mip chain or additional render pass.
  let frostOffset = max(params.frostRadius, 0.0) / safeResolution;
  let samplePositiveX = sampleInterior(
    refractedUv + vec2f(frostOffset.x, 0.0),
    halfTexel,
  );
  let sampleNegativeX = sampleInterior(
    refractedUv - vec2f(frostOffset.x, 0.0),
    halfTexel,
  );
  let samplePositiveY = sampleInterior(
    refractedUv + vec2f(0.0, frostOffset.y),
    halfTexel,
  );
  let sampleNegativeY = sampleInterior(
    refractedUv - vec2f(0.0, frostOffset.y),
    halfTexel,
  );
  let frosted = (
    samplePositiveX + sampleNegativeX + samplePositiveY + sampleNegativeY
  ) * 0.25;

  // Two independent taps provide chromatic separation. Keeping their distance
  // separate from the four frost taps lets RGB shift grow without making the
  // entire transmission blurrier. At the default 0.025 the offset is 1.8 px;
  // lil-gui can push it to 7.2 px for more pronounced edge dispersion.
  let refractionDeltaPixels = (refractedUv - originalUv) * safeResolution;
  let refractionDeltaLength = length(refractionDeltaPixels);
  let refractionAxis = select(
    vec2f(1.0, 0.0),
    refractionDeltaPixels / max(refractionDeltaLength, 0.0001),
    refractionDeltaLength > 0.0001,
  );
  let dispersionOffset = refractionAxis * (
    max(params.dispersion, 0.0) * 72.0
  ) / safeResolution;
  let towardRefraction = sampleInterior(
    refractedUv + dispersionOffset,
    halfTexel,
  );
  let awayFromRefraction = sampleInterior(
    refractedUv - dispersionOffset,
    halfTexel,
  );
  let dispersionMix = clamp(params.dispersion * 48.0, 0.0, 1.0);
  let sceneColor = vec3f(
    mix(frosted.r, towardRefraction.r, dispersionMix),
    frosted.g,
    mix(frosted.b, awayFromRefraction.b, dispersionMix),
  );

  // Absorption belongs to the front glass shell only. Using the full distance
  // to the opposite outer face exposes the tetrahedron's exit-face boundaries
  // as large triangular shadows in the final composition.
  let opticalDistance = select(0.0, sampleDistance, validExit);
  let transmittance = exp(-params.absorption * opticalDistance);
  let transmitted = sceneColor * transmittance;
  let reflected = presentCeramic(
    reflectedEnvironment * params.reflectionStrength
  ).rgb;

  // A thin film changes the Fresnel reflectance per wavelength. Modeling that
  // split directly makes the color visible even when the base dielectric F0 is
  // very low, while keeping reflection and transmission energy complementary.
  let iridescencePhase = (
    (1.0 - facing) * params.iridescenceFrequency * 6.28318530718
  );
  let spectralResponse = 0.5 + 0.5 * cos(vec3f(
      iridescencePhase,
      iridescencePhase + 2.09439510239,
      iridescencePhase + 4.18879020479,
    ));
  let grazingWeight = pow(1.0 - facing, 1.5);
  let filmAmount = clamp(params.iridescenceStrength, 0.0, 1.0) * (
    0.25 + 0.75 * grazingWeight
  );
  let filmReflectance = filmAmount * mix(
    vec3f(0.15),
    spectralResponse,
    0.85,
  );
  let fresnelRgb = clamp(
    vec3f(fresnel) + (1.0 - fresnel) * filmReflectance,
    vec3f(0.0),
    vec3f(1.0),
  );
  // Bright studio panels need a visible footprint even on a low-IOR frontal
  // face. Reuse the environment sample to isolate them; the darker room stays
  // governed by physical Fresnel.
  let environmentLuminance = dot(
    reflectedEnvironment,
    vec3f(0.2126, 0.7152, 0.0722),
  );
  let studioPanelMask = smoothstep(0.5, 0.82, environmentLuminance);
  let physicalGlass = (
    transmitted * (1.0 - fresnelRgb) + reflected * fresnelRgb
  );

  // An energy-conserving mix alone can make a white panel disappear when the
  // transmitted scene is also bright. Screen just the isolated panel over the
  // physical result: this preserves its shape and contrast without another
  // cubemap sample or making the whole shell opaque.
  let studioPanelStrength = studioPanelMask * clamp(
    params.reflectionStrength * 0.4,
    0.0,
    0.7,
  ) * (0.65 + 0.35 * grazingWeight);
  let studioPanelHighlight = clamp(
    reflected * studioPanelStrength,
    vec3f(0.0),
    vec3f(1.0),
  );
  let finalGlass = 1.0 - (
    (1.0 - clamp(physicalGlass, vec3f(0.0), vec3f(1.0)))
    * (1.0 - studioPanelHighlight)
  );
  return vec4f(finalGlass, 1.0);
}

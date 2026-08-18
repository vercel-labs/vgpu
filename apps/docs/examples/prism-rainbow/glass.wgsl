// Screen-space transmission for the prism, copied from `glass-fractal`'s
// `hero-glass-transmission.wgsl`.
//
// The material is that shader's, response for response: a dielectric Fresnel
// split between a refracted lookup and a studio reflection, four stable taps for
// frost, two more for chromatic separation, Beer-Lambert absorption over the
// distance travelled inside the solid, a thin-film tint that grows towards
// grazing angles, and a screened highlight so a bright studio panel keeps its
// shape on a low-IOR frontal face.
//
// Two things had to change, and both are simplifications. That example's glass is
// a shell around a fractal, so it approximates the interior with a nested
// tetrahedron and samples at the shell gap; this one is solid, so the refracted
// ray is followed to the face it actually leaves through — the intersection of
// the same three edges the tracer refracts through, capped front and back. And
// the environment is evaluated rather than sampled from a cubemap, for the reason
// `environment.wgsl` gives.
//
// What the glass refracts is the wall: the pass before it drew the accumulated
// rainbow into `sceneTexture`, so bending the lookup bends the caustic behind the
// prism, which is the one thing a flat 2D composite could never show.

import { presentReflection, rotateEnvironmentDirection, sampleStudioEnvironment } from "./environment.wgsl";

/**
 * Returned instead of a distance when a plane cannot be the one a ray leaves
 * through. Large enough that `min` never picks it and the caller's `< 10.0` test
 * — the prism is under a unit across, so a real exit is always well inside that —
 * reads it as a miss.
 */
const NO_EXIT: f32 = 100000.0;

struct Glass {
  viewProjection: mat4x4f,
  environmentRotation: mat4x4f,
  cameraPosition: vec3f,
  /** Beer-Lambert absorption per scene unit, in linear RGB. */
  absorption: vec3f,
  /** The cross-section, wound counter-clockwise, as `types.ts` derives it. */
  prismA: vec2f,
  prismB: vec2f,
  prismC: vec2f,
  /** Size of the target being drawn into, for the screen-space lookup. */
  resolution: vec2f,
  frontZ: f32,
  backZ: f32,
  ior: f32,
  reflectionStrength: f32,
  frostRadius: f32,
  dispersion: f32,
  iridescenceStrength: f32,
  iridescenceFrequency: f32,
  environmentExposure: f32,
}

@group(0) @binding(0) var<uniform> params: Glass;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

/** The mesh is built in world coordinates, so there is no model matrix to apply. */
@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

fn environment(direction: vec3f) -> vec3f {
  return sampleStudioEnvironment(
    rotateEnvironmentDirection(direction, params.environmentRotation),
  ) * params.environmentExposure;
}

fn dielectricFresnel(ior: f32, facing: f32) -> f32 {
  let ratio = (ior - 1.0) / (ior + 1.0);
  let f0 = ratio * ratio;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(facing, 0.0, 1.0), 5.0);
}

/** Distance to one outward plane `dot(outward, p) = offset`, or `NO_EXIT`. */
fn planeExitDistance(origin: vec3f, direction: vec3f, outward: vec3f, offset: f32) -> f32 {
  let denominator = dot(outward, direction);
  if (denominator <= 0.00001) { return NO_EXIT; }
  let distance = (offset - dot(outward, origin)) / denominator;
  return select(NO_EXIT, distance, distance > 0.0001);
}

/**
 * How far a ray inside the glass travels before it leaves.
 *
 * The prism is convex, so this is the nearest of its five bounding planes: three
 * from the cross-section's edges, rotated outward by the same rule `optics.wgsl`
 * uses, and the two caps the extrusion added.
 */
fn prismExitDistance(origin: vec3f, direction: vec3f) -> f32 {
  var corners = array<vec2f, 3>(params.prismA, params.prismB, params.prismC);
  var nearest = min(
    planeExitDistance(origin, direction, vec3f(0.0, 0.0, 1.0), params.frontZ),
    planeExitDistance(origin, direction, vec3f(0.0, 0.0, -1.0), -params.backZ),
  );
  for (var index = 0u; index < 3u; index = index + 1u) {
    let start = corners[index];
    let edge = corners[(index + 1u) % 3u] - start;
    let outward = normalize(vec2f(edge.y, -edge.x));
    nearest = min(
      nearest,
      planeExitDistance(origin, direction, vec3f(outward, 0.0), dot(outward, start)),
    );
  }
  return nearest;
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

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.worldNormal);
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflectedEnvironment = environment(reflect(incident, normal));
  let fresnel = dielectricFresnel(params.ior, facing);
  let refracted = normalize(refract(incident, normal, 1.0 / params.ior));
  // Nudged off the surface so the face this ray just entered through is not the
  // one it is found to leave by.
  let exitDistance = prismExitDistance(in.worldPosition + refracted * 0.0002, refracted);

  let originalUv = in.position.xy / max(params.resolution, vec2f(1.0));
  let validExit = exitDistance < 10.0;
  // The pass before this one rasterized the wall; there is no volume to trace, so
  // the refracted ray is resolved by projecting where it leaves the glass back
  // onto the screen and reading the wall there.
  let sampleDistance = select(0.0, exitDistance, validExit);
  let samplePoint = in.worldPosition + refracted * sampleDistance;
  let refractedUv = select(originalUv, projectToUv(samplePoint), validExit);
  let safeResolution = max(params.resolution, vec2f(1.0));
  let halfTexel = 0.5 / safeResolution;

  // Four stable bilinear taps provide a subtle frosted transmission without a
  // noise texture, temporal shimmer, mip chain or additional render pass.
  let frostOffset = max(params.frostRadius, 0.0) / safeResolution;
  let frosted = (
    sampleInterior(refractedUv + vec2f(frostOffset.x, 0.0), halfTexel)
    + sampleInterior(refractedUv - vec2f(frostOffset.x, 0.0), halfTexel)
    + sampleInterior(refractedUv + vec2f(0.0, frostOffset.y), halfTexel)
    + sampleInterior(refractedUv - vec2f(0.0, frostOffset.y), halfTexel)
  ) * 0.25;

  // Two independent taps provide chromatic separation. Keeping their distance
  // separate from the four frost taps lets RGB shift grow without making the
  // entire transmission blurrier.
  let refractionDeltaPixels = (refractedUv - originalUv) * safeResolution;
  let refractionDeltaLength = length(refractionDeltaPixels);
  let refractionAxis = select(
    vec2f(1.0, 0.0),
    refractionDeltaPixels / max(refractionDeltaLength, 0.0001),
    refractionDeltaLength > 0.0001,
  );
  let dispersionOffset = refractionAxis * (max(params.dispersion, 0.0) * 72.0) / safeResolution;
  let towardRefraction = sampleInterior(refractedUv + dispersionOffset, halfTexel);
  let awayFromRefraction = sampleInterior(refractedUv - dispersionOffset, halfTexel);
  let dispersionMix = clamp(params.dispersion * 48.0, 0.0, 1.0);
  let sceneColor = vec3f(
    mix(frosted.r, towardRefraction.r, dispersionMix),
    frosted.g,
    mix(frosted.b, awayFromRefraction.b, dispersionMix),
  );

  let transmittance = exp(-params.absorption * sampleDistance);
  let transmitted = sceneColor * transmittance;
  let reflected = presentReflection(reflectedEnvironment * params.reflectionStrength);

  // A thin film changes the Fresnel reflectance per wavelength. Modeling that
  // split directly makes the color visible even when the base dielectric F0 is
  // very low, while keeping reflection and transmission energy complementary.
  let iridescencePhase = (1.0 - facing) * params.iridescenceFrequency * 6.28318530718;
  let spectralResponse = 0.5 + 0.5 * cos(vec3f(
    iridescencePhase,
    iridescencePhase + 2.09439510239,
    iridescencePhase + 4.18879020479,
  ));
  let grazingWeight = pow(1.0 - facing, 1.5);
  let filmAmount = clamp(params.iridescenceStrength, 0.0, 1.0) * (0.25 + 0.75 * grazingWeight);
  let filmReflectance = filmAmount * mix(vec3f(0.15), spectralResponse, 0.85);
  let fresnelRgb = clamp(
    vec3f(fresnel) + (1.0 - fresnel) * filmReflectance,
    vec3f(0.0),
    vec3f(1.0),
  );

  // Bright studio panels need a visible footprint even on a low-IOR frontal
  // face. Reuse the environment sample to isolate them; the darker room stays
  // governed by physical Fresnel.
  let environmentLuminance = dot(reflectedEnvironment, vec3f(0.2126, 0.7152, 0.0722));
  let studioPanelMask = smoothstep(0.5, 0.82, environmentLuminance);
  let physicalGlass = transmitted * (1.0 - fresnelRgb) + reflected * fresnelRgb;

  // An energy-conserving mix alone can make a white panel disappear when the
  // transmitted scene is also bright. Screen just the isolated panel over the
  // physical result: this preserves its shape and contrast without another
  // environment sample or making the whole shell opaque.
  let studioPanelStrength = studioPanelMask
    * clamp(params.reflectionStrength * 0.4, 0.0, 0.7)
    * (0.65 + 0.35 * grazingWeight);
  let studioPanelHighlight = clamp(reflected * studioPanelStrength, vec3f(0.0), vec3f(1.0));
  let finalGlass = 1.0 - (
    (1.0 - clamp(physicalGlass, vec3f(0.0), vec3f(1.0))) * (1.0 - studioPanelHighlight)
  );
  return vec4f(finalGlass, 1.0);
}

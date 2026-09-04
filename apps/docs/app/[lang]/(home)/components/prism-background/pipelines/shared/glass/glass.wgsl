// Outer/front interface of the prism, based on `glass-fractal`'s
// `hero-glass-transmission.wgsl`.
//
// The material keeps that shader's dielectric response: one refracted scene
// lookup, one studio reflection, Beer-Lambert absorption over the distance
// travelled inside the solid, a thin-film tint that grows towards grazing
// angles, and an additive HDR highlight so a bright studio panel keeps its shape
// on a low-IOR frontal face. Geometric antialiasing belongs to the 4x MSAA target.
//
// Two things had to change, and both are simplifications. That example's glass is
// a shell around a fractal, so it approximates the interior with a nested
// tetrahedron and samples at the shell gap; this one is solid, so the refracted
// ray is followed to the face it actually leaves through — the intersection of
// the same three edges the CPU ray bundle refracts through, capped front and back.
// Environment reads use the same equirectangular texture path as the repository's
// environment-map and transmission examples.
//
// `sceneTexture` contains external light, the transparent back-side interface
// and internal light. The front shader follows air -> glass only as far as the
// first inner face and samples that resolved background there. The back-side
// material already owns glass -> air and TIR; tracing them again here would bend
// the same image twice.

import {
  Glass,
  dielectricFresnel,
  glassEnvironment,
  glassEnvironmentLod,
} from "./glass-common.wgsl";

/**
 * Returned instead of a distance when a plane cannot be the one a ray leaves
 * through. Large enough that `min` never picks it and the caller's `< 10.0` test
 * — the prism is under a unit across, so a real exit is always well inside that —
 * reads it as a miss.
 */
const NO_EXIT: f32 = 100000.0;

@group(0) @binding(0) var<uniform> params: Glass;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;
@group(0) @binding(3) var studioEnvironment: texture_2d<f32>;
@group(0) @binding(4) var debugEnvironment: texture_2d<f32>;
@group(0) @binding(5) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

struct SurfaceHit {
  distance: f32,
  outwardNormal: vec3f,
};

struct InteriorHit {
  position: vec3f,
  distance: f32,
  valid: u32,
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

const SURFACE_EPSILON: f32 = 0.0002;

/** Distance to one outward plane `dot(plane.xyz, p) = plane.w`, or `NO_EXIT`. */
fn planeExitDistance(origin: vec3f, direction: vec3f, plane: vec4f) -> f32 {
  let denominator = dot(plane.xyz, direction);
  if (denominator <= 0.00001) { return NO_EXIT; }
  let distance = (plane.w - dot(plane.xyz, origin)) / denominator;
  return select(NO_EXIT, distance, distance > 0.0001);
}

/**
 * How far a ray inside the glass travels before it leaves.
 *
 * The prism is convex, so this is the nearest of its five bounding planes: three
 * from the cross-section's edges, rotated outward by the same rule `optics.ts`
 * uses, and the two caps the extrusion added.
 */
fn nextSurface(origin: vec3f, direction: vec3f) -> SurfaceHit {
  // Keep the old front -> back -> side comparison order. At a geometric tie,
  // strict `<` therefore selects the same surface as the previous derivation.
  let frontPlane = params.prismPlanes[3];
  let backPlane = params.prismPlanes[4];
  let frontDistance = planeExitDistance(origin, direction, frontPlane);
  let backDistance = planeExitDistance(origin, direction, backPlane);
  var nearest = frontDistance;
  var outwardNormal = frontPlane.xyz;
  if (backDistance < nearest) {
    nearest = backDistance;
    outwardNormal = backPlane.xyz;
  }
  for (var index = 0u; index < 3u; index = index + 1u) {
    let plane = params.prismPlanes[index];
    let distance = planeExitDistance(origin, direction, plane);
    if (distance < nearest) {
      nearest = distance;
      outwardNormal = plane.xyz;
    }
  }
  return SurfaceHit(nearest, outwardNormal);
}

fn traceInteriorHit(
  entryPosition: vec3f,
  insideDirection: vec3f,
) -> InteriorHit {
  let shiftedPosition = entryPosition + insideDirection * SURFACE_EPSILON;
  let hit = nextSurface(shiftedPosition, insideDirection);
  let valid = hit.distance < 10.0;
  let distance = select(0.0, hit.distance, valid);
  return InteriorHit(
    shiftedPosition + insideDirection * distance,
    distance,
    select(0u, 1u, valid),
  );
}

fn sampleEnvironment(direction: vec3f) -> vec3f {
  return glassEnvironment(
    direction,
    params,
    studioEnvironment,
    debugEnvironment,
    environmentSampler,
    glassEnvironmentLod(direction, params),
  );
}

fn projectToUv(point: vec3f) -> vec2f {
  let clip = params.viewProjection * vec4f(point, 1.0);
  let ndc = clip.xy / max(clip.w, 0.00001);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn sampleBackground(uv: vec2f) -> vec3f {
  let resolution = max(vec2f(textureDimensions(sceneTexture)), vec2f(1.0));
  let halfTexel = 0.5 / resolution;
  let safeUv = clamp(uv, halfTexel, vec2f(1.0) - halfTexel);
  return textureSampleLevel(sceneTexture, sceneSampler, safeUv, 0.0).rgb;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.worldNormal);
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflectedEnvironment = sampleEnvironment(reflect(incident, normal));
  let fresnel = dielectricFresnel(params.fresnelF0, facing);
  let insideDirection = normalize(refract(incident, normal, 1.0 / params.ior));
  let interiorHit = traceInteriorHit(
    in.worldPosition,
    insideDirection,
  );
  let resolution = max(vec2f(textureDimensions(sceneTexture)), vec2f(1.0));
  let originalUv = in.position.xy / resolution;
  let refractedUv = select(
    originalUv,
    projectToUv(interiorHit.position),
    interiorHit.valid != 0u,
  );
  let background = sampleBackground(refractedUv);
  let transmittance = exp(-params.absorption * interiorHit.distance);
  let transmitted = select(
    vec3f(0.0),
    background * transmittance,
    interiorHit.valid != 0u,
  );
  let reflected = reflectedEnvironment * params.reflectionStrength;
  let grazingWeight = pow(1.0 - facing, 1.5);

  // Bright studio panels need a visible footprint even on a low-IOR frontal
  // face. Reuse the environment sample to isolate them; the darker room stays
  // governed by physical Fresnel.
  let environmentLuminance = dot(reflectedEnvironment, vec3f(0.2126, 0.7152, 0.0722));
  let studioPanelMask = smoothstep(0.5, 0.82, environmentLuminance);
  let physicalGlass = transmitted * (1.0 - fresnel) + reflected * fresnel;

  // An energy-conserving mix alone can make a white panel disappear when the
  // transmitted scene is also bright. Add the isolated panel in linear HDR so
  // its radiance survives until the final ACES pass, without another environment
  // sample or making the whole shell opaque.
  let studioPanelStrength = studioPanelMask
    * clamp(params.reflectionStrength * 0.4, 0.0, 0.7)
    * (0.65 + 0.35 * grazingWeight);
  let studioPanelHighlight = max(reflected * studioPanelStrength, vec3f(0.0));
  let finalGlass = max(physicalGlass, vec3f(0.0)) + studioPanelHighlight;
  return vec4f(finalGlass, 1.0);
}

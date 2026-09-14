// Inner/back interface of the prism.
//
// This is an environment-only background layer: it never reads the scene target.
// Premultiplied Fresnel blending supplies its reflection while the previously
// drawn wall and external light remain the transmitted component. Internal light
// is drawn afterwards. The front interface refracts this resolved composition.

import {
  Glass,
  dielectricFresnel,
  glassEnvironment,
} from "./glass-common.wgsl";
import { env_lod } from "../../../environment/environment-map-common.wgsl";
import { RayDirection, reflectRay, refractRay } from "./ray-footprint.wgsl";

@group(0) @binding(0) var<uniform> params: Glass;
@group(0) @binding(1) var studioEnvironment: texture_2d<f32>;
@group(0) @binding(2) var debugEnvironment: texture_2d<f32>;
@group(0) @binding(3) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

struct SurfaceHit {
  distance: f32,
  outwardNormal: vec3f,
  planeIndex: u32,
};

struct ExitPath {
  position: vec3f,
  direction: RayDirection,
  incidentDirection: RayDirection,
  inwardNormal: RayDirection,
  escaped: u32,
  planeIndex: u32,
};

const NO_HIT: f32 = 100000.0;
// The rasterized bevel need not lie on any of the five ideal planes.
const NO_PLANE: u32 = 5u;
const MAX_INTERNAL_BOUNCES: u32 = 3u;

fn sampleEnvironment(direction: RayDirection) -> vec3f {
  return glassEnvironment(
    direction.value,
    params,
    studioEnvironment,
    debugEnvironment,
    environmentSampler,
    env_lod(0.0, direction.dx, direction.dy, params.environmentTexelAngle),
  );
}

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

fn planeHitDistance(
  origin: vec3f,
  direction: vec3f,
  plane: vec4f,
  planeIndex: u32,
  departedPlane: u32,
) -> f32 {
  if (planeIndex == departedPlane) { return NO_HIT; }
  let denominator = dot(plane.xyz, direction);
  if (denominator <= 0.00001) { return NO_HIT; }
  let distance = (plane.w - dot(plane.xyz, origin)) / denominator;
  return select(NO_HIT, distance, distance >= 0.0);
}

/** Nearest ideal prism plane reached by a ray already inside the glass. */
fn nextSurface(origin: vec3f, direction: vec3f, departedPlane: u32) -> SurfaceHit {
  // Exclude the interface we just left by identity. Nudging the origin or
  // rejecting short positive distances can skip a different face near a corner.
  // Keep the old front -> back -> side comparison order for exact tie parity.
  let frontPlane = params.prismPlanes[3];
  let backPlane = params.prismPlanes[4];
  var nearest = planeHitDistance(origin, direction, frontPlane, 3u, departedPlane);
  var planeIndex = 3u;
  var normal = frontPlane.xyz;

  let backDistance = planeHitDistance(origin, direction, backPlane, 4u, departedPlane);
  if (backDistance < nearest) {
    nearest = backDistance;
    normal = backPlane.xyz;
    planeIndex = 4u;
  }

  for (var index = 0u; index < 3u; index = index + 1u) {
    let plane = params.prismPlanes[index];
    let distance = planeHitDistance(origin, direction, plane, index, departedPlane);
    if (distance < nearest) {
      nearest = distance;
      normal = plane.xyz;
      planeIndex = index;
    }
  }
  return SurfaceHit(nearest, normal, planeIndex);
}

/**
 * Follow glass -> air transmission, continuing through real TIR bounces.
 *
 * The rasterized back face supplies the first interface normal. Subsequent hits
 * use the same five ideal planes as the outer shader and CPU tracer. Three
 * bounces are enough for this convex prism and match `PRISM_MAX_INTERNAL_BOUNCES`.
 */
fn traceExit(
  firstPosition: vec3f,
  firstDirection: RayDirection,
  firstInwardNormal: RayDirection,
  firstPlane: u32,
) -> ExitPath {
  var position = firstPosition;
  var direction = firstDirection;
  var inwardNormal = firstInwardNormal;
  var planeIndex = firstPlane;

  for (var bounce = 0u; bounce <= MAX_INTERNAL_BOUNCES; bounce = bounce + 1u) {
    let transmitted = refractRay(direction, inwardNormal, params.ior);
    if (length(transmitted.value) > 0.00001) {
      return ExitPath(position, transmitted, direction, inwardNormal, 1u, planeIndex);
    }

    direction = reflectRay(direction, inwardNormal);
    let hit = nextSurface(position, direction.value, planeIndex);
    if (hit.distance >= 10.0) { break; }
    position = position + direction.value * hit.distance;
    planeIndex = hit.planeIndex;
    // Subsequent interfaces are ideal planes with constant local normals.
    inwardNormal = RayDirection(-hit.outwardNormal, vec3f(0.0), vec3f(0.0));
  }

  return ExitPath(position, direction, direction, inwardNormal, 0u, planeIndex);
}

/**
 * An inner-face reflection remains inside the solid. Follow it to the next
 * interface (and through any subsequent TIR bounces) before using its direction
 * to sample the exterior studio environment.
 */
fn traceReflectedEnvironmentExit(
  surfacePosition: vec3f,
  incidentDirection: RayDirection,
  inwardNormal: RayDirection,
  departedPlane: u32,
) -> ExitPath {
  let direction = reflectRay(incidentDirection, inwardNormal);
  let hit = nextSurface(surfacePosition, direction.value, departedPlane);
  if (hit.distance >= 10.0) {
    return ExitPath(surfacePosition, direction, direction, inwardNormal, 0u, departedPlane);
  }
  let position = surfacePosition + direction.value * hit.distance;
  return traceExit(
    position,
    direction,
    RayDirection(-hit.outwardNormal, vec3f(0.0), vec3f(0.0)),
    hit.planeIndex,
  );
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  // Back-facing triangles expose their inward normal to the camera ray.
  let inwardNormal = -normalize(in.worldNormal);
  // Capture derivatives before tracing. Adjacent pixels can hit different faces
  // or take different TIR paths; differentiating their final directions would
  // mistake that jump for a broad footprint and paint blurred mip seams.
  let exit = traceExit(
    in.worldPosition,
    RayDirection(incident, dpdx(incident), dpdy(incident)),
    RayDirection(inwardNormal, dpdx(inwardNormal), dpdy(inwardNormal)),
    NO_PLANE,
  );

  let reflectedExit = traceReflectedEnvironmentExit(
    exit.position,
    exit.incidentDirection,
    exit.inwardNormal,
    exit.planeIndex,
  );
  let reflectedFacing = clamp(
    -dot(reflectedExit.incidentDirection.value, reflectedExit.inwardNormal.value),
    0.0,
    1.0,
  );
  let reflectedExitTransmission = select(
    0.0,
    1.0 - dielectricFresnel(params.fresnelF0, reflectedFacing),
    reflectedExit.escaped != 0u,
  );
  let reflectedEnvironment = sampleEnvironment(reflectedExit.direction)
    * params.reflectionStrength
    * reflectedExitTransmission;
  let facing = clamp(-dot(exit.incidentDirection.value, exit.inwardNormal.value), 0.0, 1.0);
  let fresnel = dielectricFresnel(params.fresnelF0, facing);
  let reflectionWeight = select(
    1.0,
    fresnel,
    exit.escaped != 0u,
  );
  return vec4f(reflectedEnvironment * reflectionWeight, reflectionWeight);
}

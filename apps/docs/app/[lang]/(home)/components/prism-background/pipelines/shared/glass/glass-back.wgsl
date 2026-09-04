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
  glassEnvironmentLod,
} from "./glass-common.wgsl";

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
};

struct ExitPath {
  position: vec3f,
  direction: vec3f,
  incidentDirection: vec3f,
  inwardNormal: vec3f,
  escaped: u32,
};

const NO_HIT: f32 = 100000.0;
const SURFACE_EPSILON: f32 = 0.0002;
const MAX_INTERNAL_BOUNCES: u32 = 3u;

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

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

fn planeHitDistance(origin: vec3f, direction: vec3f, plane: vec4f) -> f32 {
  let denominator = dot(plane.xyz, direction);
  if (denominator <= 0.00001) { return NO_HIT; }
  let distance = (plane.w - dot(plane.xyz, origin)) / denominator;
  return select(NO_HIT, distance, distance > SURFACE_EPSILON);
}

/** Nearest ideal prism plane reached by a ray already inside the glass. */
fn nextSurface(origin: vec3f, direction: vec3f) -> SurfaceHit {
  // Keep the old front -> back -> side comparison order for exact tie parity.
  let frontPlane = params.prismPlanes[3];
  let backPlane = params.prismPlanes[4];
  var nearest = planeHitDistance(origin, direction, frontPlane);
  var normal = frontPlane.xyz;

  let backDistance = planeHitDistance(origin, direction, backPlane);
  if (backDistance < nearest) {
    nearest = backDistance;
    normal = backPlane.xyz;
  }

  for (var index = 0u; index < 3u; index = index + 1u) {
    let plane = params.prismPlanes[index];
    let distance = planeHitDistance(origin, direction, plane);
    if (distance < nearest) {
      nearest = distance;
      normal = plane.xyz;
    }
  }
  return SurfaceHit(nearest, normal);
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
  firstDirection: vec3f,
  firstInwardNormal: vec3f,
) -> ExitPath {
  var position = firstPosition;
  var direction = firstDirection;
  var inwardNormal = firstInwardNormal;

  for (var bounce = 0u; bounce <= MAX_INTERNAL_BOUNCES; bounce = bounce + 1u) {
    let transmitted = refract(direction, inwardNormal, params.ior);
    if (length(transmitted) > 0.00001) {
      return ExitPath(position, normalize(transmitted), direction, inwardNormal, 1u);
    }

    direction = normalize(reflect(direction, inwardNormal));
    let hit = nextSurface(position + direction * SURFACE_EPSILON, direction);
    if (hit.distance >= 10.0) { break; }
    position = position + direction * (hit.distance + SURFACE_EPSILON);
    inwardNormal = -hit.outwardNormal;
  }

  return ExitPath(position, direction, direction, inwardNormal, 0u);
}

/**
 * An inner-face reflection remains inside the solid. Follow it to the next
 * interface (and through any subsequent TIR bounces) before using its direction
 * to sample the exterior studio environment.
 */
fn traceReflectedEnvironmentExit(
  surfacePosition: vec3f,
  incidentDirection: vec3f,
  inwardNormal: vec3f,
) -> ExitPath {
  let direction = normalize(reflect(incidentDirection, inwardNormal));
  let shiftedPosition = surfacePosition + direction * SURFACE_EPSILON;
  let hit = nextSurface(shiftedPosition, direction);
  if (hit.distance >= 10.0) {
    return ExitPath(surfacePosition, direction, direction, inwardNormal, 0u);
  }
  let position = shiftedPosition + direction * hit.distance;
  return traceExit(position, direction, -hit.outwardNormal);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  let incident = -view;
  // Back-facing triangles expose their inward normal to the camera ray.
  let inwardNormal = -normalize(in.worldNormal);
  let exit = traceExit(in.worldPosition, incident, inwardNormal);

  let reflectedExit = traceReflectedEnvironmentExit(
    exit.position,
    exit.incidentDirection,
    exit.inwardNormal,
  );
  let reflectedFacing = clamp(
    -dot(reflectedExit.incidentDirection, reflectedExit.inwardNormal),
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
  let facing = clamp(-dot(exit.incidentDirection, exit.inwardNormal), 0.0, 1.0);
  let fresnel = dielectricFresnel(params.fresnelF0, facing);
  let reflectionWeight = select(
    1.0,
    fresnel,
    exit.escaped != 0u,
  );
  return vec4f(reflectedEnvironment * reflectionWeight, reflectionWeight);
}

// Inner/back interface of the prism.
//
// Rendering back faces first lets the outer pass sample the result at the exact
// point its camera ray leaves the solid. In camera-ray order this interface is
// glass -> air, so Snell uses eta = IOR. The refracted ray is then intersected
// with the real wall plane instead of being approximated by a fixed UV offset.
// Total internal reflection keeps tracing inside the solid, matching the CPU
// light path instead of deleting that radiance at the first grazing interface.

import {
  Glass,
  dielectricFresnel,
  glassEnvironment,
  projectToUv,
  sampleScene,
} from "./glass-common.wgsl";

@group(0) @binding(0) var<uniform> params: Glass;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

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

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = normal;
  return out;
}

fn planeHitDistance(origin: vec3f, direction: vec3f, outward: vec3f, offset: f32) -> f32 {
  let denominator = dot(outward, direction);
  if (denominator <= 0.00001) { return NO_HIT; }
  let distance = (offset - dot(outward, origin)) / denominator;
  return select(NO_HIT, distance, distance > SURFACE_EPSILON);
}

/** Nearest ideal prism plane reached by a ray already inside the glass. */
fn nextSurface(origin: vec3f, direction: vec3f) -> SurfaceHit {
  var nearest = planeHitDistance(
    origin,
    direction,
    vec3f(0.0, 0.0, 1.0),
    params.frontZ,
  );
  var normal = vec3f(0.0, 0.0, 1.0);

  let backDistance = planeHitDistance(
    origin,
    direction,
    vec3f(0.0, 0.0, -1.0),
    -params.backZ,
  );
  if (backDistance < nearest) {
    nearest = backDistance;
    normal = vec3f(0.0, 0.0, -1.0);
  }

  var corners = array<vec2f, 3>(params.prismA, params.prismB, params.prismC);
  for (var index = 0u; index < 3u; index = index + 1u) {
    let start = corners[index];
    let edge = corners[(index + 1u) % 3u] - start;
    let outward2 = normalize(vec2f(edge.y, -edge.x));
    let outward = vec3f(outward2, 0.0);
    let distance = planeHitDistance(
      origin,
      direction,
      outward,
      dot(outward2, start),
    );
    if (distance < nearest) {
      nearest = distance;
      normal = outward;
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
  let wallDenominator = exit.direction.z;
  let wallDistance = (params.wallZ - exit.position.z) / select(
    0.00001,
    wallDenominator,
    abs(wallDenominator) > 0.00001,
  );
  let validWallHit = exit.escaped != 0u && wallDistance > 0.00001;

  let originalUv = in.position.xy / max(params.resolution, vec2f(1.0));
  let wallPoint = exit.position + exit.direction * max(wallDistance, 0.0);
  let refractedUv = select(
    originalUv,
    projectToUv(wallPoint, params.viewProjection),
    validWallHit,
  );
  let halfTexel = 0.5 / max(params.resolution, vec2f(1.0));
  let wallColor = sampleScene(sceneTexture, sceneSampler, refractedUv, halfTexel);
  let exteriorColor = glassEnvironment(exit.direction, params) * params.reflectionStrength;
  let sceneColor = select(exteriorColor, wallColor, validWallHit);

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
    1.0 - dielectricFresnel(params.ior, reflectedFacing),
    reflectedExit.escaped != 0u,
  );
  let reflectedEnvironment = glassEnvironment(reflectedExit.direction, params)
    * params.reflectionStrength
    * reflectedExitTransmission;
  let facing = clamp(-dot(exit.incidentDirection, exit.inwardNormal), 0.0, 1.0);
  let fresnel = dielectricFresnel(params.ior, facing);
  let radiance = select(
    reflectedEnvironment,
    mix(sceneColor, reflectedEnvironment, fresnel),
    exit.escaped != 0u,
  );
  return vec4f(radiance, 1.0);
}

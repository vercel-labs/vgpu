import { RayDirection, reflectRay, refractRay } from "../ray-footprint.wgsl";
struct Inputs {
  incident: vec3f,
  incidentDx: vec3f,
  incidentDy: vec3f,
  normal: vec3f,
  normalDx: vec3f,
  normalDy: vec3f,
  eta: f32,
}
@group(0) @binding(0) var<uniform> inputs: Inputs;
@fragment fn fs_main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let ray = RayDirection(inputs.incident, inputs.incidentDx, inputs.incidentDy);
  let normal = RayDirection(inputs.normal, inputs.normalDx, inputs.normalDy);
  let reflected = reflectRay(ray, normal);
  let transmitted = refractRay(ray, normal, inputs.eta);
  let fields = array<vec3f, 6>(
    reflected.value, reflected.dx, reflected.dy,
    transmitted.value, transmitted.dx, transmitted.dy,
  );
  return vec4f(fields[u32(p.x)], 1.0);
}

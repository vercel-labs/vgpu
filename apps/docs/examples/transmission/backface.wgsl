/** Exact exit point/normal for the rotated cube, following the refracted ray (not camera ray). */
export struct CubeExit { position: vec3f, normal: vec3f, distance: f32 };

export fn trace_cube_exit(model: mat4x4f, entry: vec3f, direction: vec3f, half_extent: f32) -> CubeExit {
  let rotation = mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz);
  let inverse_rotation = transpose(rotation);
  let local_entry = inverse_rotation * (entry - model[3].xyz);
  let local_direction = inverse_rotation * direction;
  let safe = sign(local_direction) * max(abs(local_direction), vec3f(1e-6));
  let boundary = sign(local_direction) * half_extent;
  let candidates = select(vec3f(1e6), (boundary - local_entry) / safe, abs(local_direction) > vec3f(1e-5));
  let distance = min(candidates.x, min(candidates.y, candidates.z));
  var local_normal = vec3f(0.0);
  if (candidates.x <= candidates.y && candidates.x <= candidates.z) { local_normal.x = sign(local_direction.x); }
  else if (candidates.y <= candidates.z) { local_normal.y = sign(local_direction.y); }
  else { local_normal.z = sign(local_direction.z); }
  return CubeExit(entry + direction * distance, normalize(rotation * local_normal), distance);
}

export fn transmitted_cube_inside_ray(model: mat4x4f, entry: vec3f, inside: vec3f, eta: f32, half_extent: f32, fallback_thickness: f32, double_amount: f32) -> vec4f {
  if (dot(inside, inside) < 1e-6) { return vec4f(entry, 0.0); }
  if (double_amount < 1e-3) { return vec4f(entry + inside * (fallback_thickness + 4.0), 1.0); }
  // Every cone sample intersects independently: averaging one central exit would retain
  // the sharp back-face discontinuity that rough glass is supposed to spread out.
  let exit = trace_cube_exit(model, entry, inside, half_extent);
  let outgoing = refract(inside, -exit.normal, 1.0 / eta);
  if (dot(outgoing, outgoing) < 1e-6) { return vec4f(exit.position + inside * 4.0, 1.0); }
  return vec4f(exit.position + outgoing * 4.0, 1.0);
}

export fn transmitted_cube_ray(model: mat4x4f, entry: vec3f, incident: vec3f, normal: vec3f, eta: f32, half_extent: f32, fallback_thickness: f32, double_amount: f32) -> vec4f {
  return transmitted_cube_inside_ray(model, entry, refract(incident, normal, eta), eta, half_extent, fallback_thickness, double_amount);
}

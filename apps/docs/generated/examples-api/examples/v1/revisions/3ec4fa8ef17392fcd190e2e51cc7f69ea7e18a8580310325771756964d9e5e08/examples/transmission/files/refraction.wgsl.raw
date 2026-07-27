/** Projects a world point onto a top-origin screen-space uv. */
export fn project_to_uv(view_projection: mat4x4f, world_position: vec3f) -> vec2f {
  let clip = view_projection * vec4f(world_position, 1.0);
  let ndc = clip.xy / max(clip.w, 1e-4);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

/** How far past the exit face the transmitted ray is followed before projection. */
const RAY_DISTANCE: f32 = 4.0;

/** Follows one wavelength through the entry and optional exit interfaces. */
export fn transmitted_ray(entry: vec3f, incident: vec3f, normal: vec3f, eta: f32, exit_normal: vec3f, thickness: f32, double_amount: f32) -> vec4f {
  let inside = refract(incident, normal, eta);
  if (dot(inside, inside) < 1e-6) { return vec4f(entry, 0.0); }
  let exit_position = entry + inside * thickness;
  if (double_amount < 1e-3) { return vec4f(exit_position + inside * RAY_DISTANCE, 1.0); }
  let outgoing = refract(inside, -exit_normal, 1.0 / eta);
  if (dot(outgoing, outgoing) < 1e-6) { return vec4f(exit_position + inside * RAY_DISTANCE, 1.0); }
  return vec4f(exit_position + outgoing * RAY_DISTANCE, 1.0);
}

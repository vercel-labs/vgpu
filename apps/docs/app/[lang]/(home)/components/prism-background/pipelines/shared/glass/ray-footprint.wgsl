/** A unit direction and its local change over one screen pixel. */
export struct RayDirection {
  value: vec3f,
  dx: vec3f,
  dy: vec3f,
}

fn normalizedRay(value: vec3f, dx: vec3f, dy: vec3f) -> RayDirection {
  let magnitude = length(value);
  let unit = value / magnitude;
  return RayDirection(
    unit,
    (dx - unit * dot(unit, dx)) / magnitude,
    (dy - unit * dot(unit, dy)) / magnitude,
  );
}

/** Differentiate reflection along this ray's interface, never across hit faces. */
export fn reflectRay(ray: RayDirection, normal: RayDirection) -> RayDirection {
  let facing = dot(ray.value, normal.value);
  let facingDx = dot(ray.dx, normal.value) + dot(ray.value, normal.dx);
  let facingDy = dot(ray.dy, normal.value) + dot(ray.value, normal.dy);
  return normalizedRay(
    reflect(ray.value, normal.value),
    ray.dx - 2.0 * (facingDx * normal.value + facing * normal.dx),
    ray.dy - 2.0 * (facingDy * normal.value + facing * normal.dy),
  );
}

/** Snell's law and its differential; a zero value marks total internal reflection. */
export fn refractRay(ray: RayDirection, normal: RayDirection, eta: f32) -> RayDirection {
  let facing = dot(ray.value, normal.value);
  let k = 1.0 - eta * eta * (1.0 - facing * facing);
  if (k < 0.0) {
    return RayDirection(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  }
  let root = sqrt(k);
  let scale = eta * facing + root;
  // At the critical angle the footprint tends to infinity. Bound the divisor
  // for finite arithmetic; the environment sampler clamps the resulting LOD.
  let slope = eta + eta * eta * facing / max(root, 0.00001);
  let facingDx = dot(ray.dx, normal.value) + dot(ray.value, normal.dx);
  let facingDy = dot(ray.dy, normal.value) + dot(ray.value, normal.dy);
  return normalizedRay(
    eta * ray.value - scale * normal.value,
    eta * ray.dx - slope * facingDx * normal.value - scale * normal.dx,
    eta * ray.dy - slope * facingDy * normal.value - scale * normal.dy,
  );
}

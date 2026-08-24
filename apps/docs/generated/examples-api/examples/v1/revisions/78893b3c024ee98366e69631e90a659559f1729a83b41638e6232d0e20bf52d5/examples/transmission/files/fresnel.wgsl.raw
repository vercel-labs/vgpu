/** Schlick dielectric Fresnel for an outside IOR of 1. */
export fn dielectric_fresnel(ior: f32, facing: f32) -> f32 {
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  return f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
}

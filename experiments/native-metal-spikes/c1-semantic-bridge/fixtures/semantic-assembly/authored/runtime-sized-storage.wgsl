struct Particle {
  @size(8) mass: u32,
  id: u32,
}

struct Values {
  prefix: u32,
  particles: array<Particle>,
}

@group(0) @binding(0) var<storage, read> values: Values;

@compute @workgroup_size(1) fn compute_main() {
  _ = values.prefix + values.particles[0].mass + arrayLength(&values.particles);
}

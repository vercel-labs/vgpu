struct Particle {
  @size(8) mass: u32,
  id: u32,
}

struct Values {
  prefix: u32,
  particles: array<Particle>,
}

@group(0) @binding(0) var<storage, read> values: Values;
@group(0) @binding(1) var<storage, read_write> output: array<u32, 2>;

@compute @workgroup_size(1) fn compute_main() {
  let count = arrayLength(&values.particles);
  output[0] = count;
  output[1] = values.particles[count - 1u].id;
}

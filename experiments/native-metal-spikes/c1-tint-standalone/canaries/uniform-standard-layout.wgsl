// Tint's uniform_buffer_standard_layout environment feature permits this intrinsic stride.
// The semantic layout reported by Tint is the oracle; a host packer is not.
struct Params {
  values: array<f32, 3>,
}

struct Output {
  values: array<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: Output;

@compute @workgroup_size(1) fn main() {
  output.values[0] = params.values[0] + params.values[1] + params.values[2];
}

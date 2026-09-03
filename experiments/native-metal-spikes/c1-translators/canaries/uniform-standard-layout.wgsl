// The current host packer uses the natural four-byte stride for this uniform array.
// Dawn exposes uniform_buffer_standard_layout, which makes this layout valid.
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

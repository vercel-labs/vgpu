struct RuntimeValues {
  prefix: u32,
  values: array<u32>,
}

@group(0) @binding(0)
var<storage, read> runtime_values: RuntimeValues;

@compute @workgroup_size(1)
fn c3_runtime_array() {
  let count = arrayLength(&runtime_values.values);
}

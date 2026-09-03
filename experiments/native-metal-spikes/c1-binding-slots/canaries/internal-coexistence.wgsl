struct Values {
  prefix: u32,
  values: array<u32>,
}

struct Result {
  value: u32,
}

@group(0) @binding(0) var<storage, read_write> values: Values;
@group(0) @binding(1) var<storage, read_write> result: Result;

@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let divisor = max(id.x, 1u);
  let length = arrayLength(&values.values);
  result.value = values.values[id.x] / divisor + length;
}

@compute @workgroup_size(1) fn fixed_prefix_only(
  @builtin(global_invocation_id) id: vec3u,
) {
  let divisor = max(id.x, 1u);
  result.value = values.prefix / divisor;
}

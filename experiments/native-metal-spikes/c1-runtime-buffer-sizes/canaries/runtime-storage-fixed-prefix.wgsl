struct RuntimeValues {
  prefix: u32,
  values: array<u32>,
}

struct Result {
  value: u32,
}

struct QueriedValues {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read> runtimeValues: RuntimeValues;
@group(0) @binding(1) var<storage, read_write> result: Result;
@group(0) @binding(2) var<storage, read> queriedValues: QueriedValues;

@compute @workgroup_size(1) fn fixedPrefixOnly() {
  result.value = runtimeValues.prefix;
}

@compute @workgroup_size(1) fn mixedSizeQuery() {
  result.value = queriedValues.values[0] + runtimeValues.prefix;
}

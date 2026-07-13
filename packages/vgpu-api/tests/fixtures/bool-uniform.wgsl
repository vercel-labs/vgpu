struct Params {
  enabled: bool,
};

@group(0) @binding(0) var<uniform> badUniform: Params;

@compute @workgroup_size(1) fn main() {
  if (badUniform.enabled) {
    return;
  }
}
